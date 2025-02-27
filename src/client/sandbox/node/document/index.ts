import SandboxBase from '../../base';
import IframeSandbox from '../../iframe';
import nativeMethods from '../../native-methods';
import domProcessor from '../../../dom-processor';
import settings from '../../../settings';
import { isIE } from '../../../utils/browser';

import {
    isIframeWithoutSrc,
    getFrameElement,
    isImgElement,
    isShadowUIElement,
} from '../../../utils/dom';

import DocumentWriter from './writer';
import ShadowUI from './../../shadow-ui';
import INTERNAL_PROPS from '../../../../processing/dom/internal-properties';
import LocationAccessorsInstrumentation from '../../code-instrumentation/location';

import {
    overrideDescriptor,
    createOverriddenDescriptor,
    overrideFunction,
} from '../../../utils/overriding';

import NodeSandbox from '../index';

import {
    getDestinationUrl,
    isSpecialPage,
    convertToProxyUrl,
    getCrossDomainProxyOrigin,
} from '../../../utils/url';

import { getReferrer } from '../../../utils/destination-location';
import DocumentTitleStorageInitializer from './title-storage-initializer';
import CookieSandbox from '../../cookie';

export default class DocumentSandbox extends SandboxBase {
    writers = new Map<Document, DocumentWriter>();

    constructor (private readonly _nodeSandbox: NodeSandbox,
        private readonly _shadowUI: ShadowUI,
        private readonly _cookieSandbox: CookieSandbox,
        private readonly _iframeSandbox: IframeSandbox,
        private readonly _documentTitleStorageInitializer?: DocumentTitleStorageInitializer) {

        super();
    }

    static forceProxySrcForImageIfNecessary (element: Element): void {
        if (isImgElement(element) && settings.get().forceProxySrcForImage)
            element[INTERNAL_PROPS.forceProxySrcForImage] = true;
    }

    private static _isDocumentInDesignMode (doc: HTMLDocument): boolean {
        return doc.designMode === 'on';
    }

    private _isUninitializedIframeWithoutSrc (win: Window): boolean {
        const frameElement = getFrameElement(win);

        return win !== win.top && frameElement && isIframeWithoutSrc(frameElement) &&
               !IframeSandbox.isIframeInitialized(frameElement as HTMLIFrameElement);
    }

    private _beforeDocumentCleaned () {
        this._nodeSandbox.mutation.onBeforeDocumentCleaned(this.document);
    }

    private _onDocumentClosed () {
        this._nodeSandbox.mutation.onDocumentClosed(this.document);
    }

    private static _shouldEmitDocumentCleanedEvents (doc) {
        if (isIE) {
            if (doc.readyState !== 'loading')
                return true;

            const window = doc.defaultView;

            if (window[INTERNAL_PROPS.documentWasCleaned])
                return false;

            const iframe = window && getFrameElement(window);

            return iframe && isIframeWithoutSrc(iframe);
        }

        return doc.readyState !== 'loading' && doc.readyState !== 'uninitialized';
    }

    private _performDocumentWrite (doc: Document, args, ln?: boolean) {
        const shouldEmitEvents = DocumentSandbox._shouldEmitDocumentCleanedEvents(this.document);

        if (shouldEmitEvents)
            this._beforeDocumentCleaned();

        const result = this.writers.get(doc).write(args, ln, shouldEmitEvents);

        // NOTE: B234357
        if (!shouldEmitEvents)
            this._nodeSandbox.processNodes(null, this.document);

        return result;
    }

    private static _definePropertyDescriptor (owner, childOfOwner, prop, overriddenDescriptor) {
        // NOTE: The 'URL', 'domain' and 'referrer' properties are non configurable in IE and Edge
        if (!overriddenDescriptor.configurable) {
            // NOTE: property doesn't redefined yet
            if (!childOfOwner.hasOwnProperty(prop)) // eslint-disable-line no-prototype-builtins
                nativeMethods.objectDefineProperty(childOfOwner, prop, overriddenDescriptor);
        }
        else
            nativeMethods.objectDefineProperty(owner, prop, overriddenDescriptor);
    }

    iframeDocumentOpen (window, document, args) {
        const iframe = window.frameElement;
        const result = nativeMethods.documentOpen.apply(document, args);

        nativeMethods.objectDefineProperty(window, INTERNAL_PROPS.documentWasCleaned, { value: true, configurable: true });
        this._nodeSandbox.iframeSandbox.onIframeBeganToRun(iframe);

        return result;
    }

    attach (window, document, partialInitializationForNotLoadedIframe = false) {
        if (!this.writers.size)
            super.attach(window, document);

        if (!this.writers.has(document)) {
            this.writers.set(document, new DocumentWriter(window, document));

            this._nodeSandbox.mutation.on(this._nodeSandbox.mutation.BEFORE_DOCUMENT_CLEANED_EVENT, () => {
                this.writers.set(document, new DocumentWriter(window, document));
            });
        }

        const documentSandbox = this;
        const docPrototype    = window.Document.prototype;

        const overriddenMethods = {
            open: function (this: Document, ...args: [string?, string?, string?, boolean?]) {
                const isUninitializedIframe = documentSandbox._isUninitializedIframeWithoutSrc(window);

                if (!isUninitializedIframe)
                    documentSandbox._beforeDocumentCleaned();

                if (isIE)
                    return window.parent[INTERNAL_PROPS.hammerhead].sandbox.node.doc.iframeDocumentOpen(window, this, args);

                const result = nativeMethods.documentOpen.apply(this, args);

                // NOTE: Chrome does not remove the "%hammerhead%" property from window
                // after document.open call
                const objectDefinePropertyFn = window[INTERNAL_PROPS.hammerhead]
                    ? window[INTERNAL_PROPS.hammerhead].nativeMethods.objectDefineProperty
                    : window.Object.defineProperty;

                objectDefinePropertyFn(window, INTERNAL_PROPS.documentWasCleaned, { value: true, configurable: true });

                if (!isUninitializedIframe)
                    documentSandbox._nodeSandbox.mutation.onDocumentCleaned(window, this);
                else {
                    const iframe = getFrameElement(window);

                    if (iframe)
                        documentSandbox._iframeSandbox.processIframe(iframe);
                }

                return result;
            },

            close: function (this: Document, ...args: []) {
                // NOTE: IE11 raise the "load" event only when the document.close method is called. We need to
                // restore the overridden document.open and document.write methods before Hammerhead injection, if the
                // window is not initialized.
                if (isIE && !IframeSandbox.isWindowInited(window))
                    nativeMethods.restoreDocumentMeths(window, this);

                // NOTE: IE doesn't run scripts in iframe if iframe.documentContent.designMode equals 'on' (GH-871)
                if (DocumentSandbox._isDocumentInDesignMode(this))
                    ShadowUI.removeSelfRemovingScripts(this);

                const result = nativeMethods.documentClose.apply(this, args);

                if (!documentSandbox._isUninitializedIframeWithoutSrc(window))
                    documentSandbox._onDocumentClosed();

                const iframe = getFrameElement(window);

                // NOTE: Firefox misses the Hammerhead instance after the iframe.contentDocument.close function calling (GH-1821)
                if (iframe)
                    documentSandbox._nodeSandbox.iframeSandbox.onIframeBeganToRun(iframe as HTMLIFrameElement);

                return result;
            },

            write: function () {
                return documentSandbox._performDocumentWrite(this, arguments);
            },

            writeln: function () {
                return documentSandbox._performDocumentWrite(this, arguments, true);
            },
        };

        overrideFunction(window[nativeMethods.documentOpenPropOwnerName].prototype, 'open', overriddenMethods.open);
        overrideFunction(window[nativeMethods.documentClosePropOwnerName].prototype, 'close', overriddenMethods.close);
        overrideFunction(window[nativeMethods.documentWritePropOwnerName].prototype, 'write', overriddenMethods.write);
        overrideFunction(window[nativeMethods.documentWriteLnPropOwnerName].prototype, 'writeln', overriddenMethods.writeln);

        overrideFunction(document, 'open', overriddenMethods.open);
        overrideFunction(document, 'close', overriddenMethods.close);
        overrideFunction(document, 'write', overriddenMethods.write);
        overrideFunction(document, 'writeln', overriddenMethods.writeln);

        if (document.open !== overriddenMethods.open)
            overrideFunction(document, 'open', overriddenMethods.open);

        overrideFunction(docPrototype, 'createElement', function (this: Document, ...args: [string, ElementCreationOptions?]) {
            const el = nativeMethods.createElement.apply(this, args);

            DocumentSandbox.forceProxySrcForImageIfNecessary(el);
            domProcessor.processElement(el, convertToProxyUrl);
            documentSandbox._nodeSandbox.processNodes(el);

            return el;
        });

        overrideFunction(docPrototype, 'createElementNS', function (this: Document, ...args: [string, string, (string | ElementCreationOptions)?]) {
            const el = nativeMethods.createElementNS.apply(this, args);

            DocumentSandbox.forceProxySrcForImageIfNecessary(el);
            domProcessor.processElement(el, convertToProxyUrl);
            documentSandbox._nodeSandbox.processNodes(el);

            return el;
        });

        overrideFunction(docPrototype, 'createDocumentFragment', function (this: Document, ...args: []) {
            const fragment = nativeMethods.createDocumentFragment.apply(this, args);

            documentSandbox._nodeSandbox.processNodes(fragment);

            return fragment;
        });

        const htmlDocPrototype = window.HTMLDocument.prototype;
        let storedDomain       = '';

        if (nativeMethods.documentDocumentURIGetter) {
            overrideDescriptor(docPrototype, 'documentURI', {
                getter: function () {
                    return getDestinationUrl(nativeMethods.documentDocumentURIGetter.call(this));
                },
            });
        }

        const referrerOverriddenDescriptor = createOverriddenDescriptor(docPrototype, 'referrer', {
            getter: function () {
                const referrer = getDestinationUrl(nativeMethods.documentReferrerGetter.call(this));

                if (referrer === getCrossDomainProxyOrigin() + '/')
                    return getReferrer();

                return isSpecialPage(referrer) ? '' : referrer;
            },
        });

        DocumentSandbox._definePropertyDescriptor(docPrototype, htmlDocPrototype, 'referrer', referrerOverriddenDescriptor);

        const urlOverriddenDescriptor = createOverriddenDescriptor(docPrototype, 'URL', {
            getter: function () {
                // eslint-disable-next-line no-restricted-properties
                return LocationAccessorsInstrumentation.getLocationWrapper(this).href;
            },
        });

        DocumentSandbox._definePropertyDescriptor(docPrototype, htmlDocPrototype, 'URL', urlOverriddenDescriptor);

        const domainPropertyOwner = nativeMethods.objectHasOwnProperty.call(docPrototype, 'domain')
            ? docPrototype
            : htmlDocPrototype;

        const domainOverriddenDescriptor = createOverriddenDescriptor(domainPropertyOwner, 'domain', {
            getter: () => {
                // eslint-disable-next-line no-restricted-properties
                return storedDomain || LocationAccessorsInstrumentation.getLocationWrapper(window).hostname;
            },
            setter: value => {
                storedDomain = value;
            },
        });

        DocumentSandbox._definePropertyDescriptor(domainPropertyOwner, htmlDocPrototype, 'domain', domainOverriddenDescriptor);

        overrideDescriptor(docPrototype, 'styleSheets', {
            getter: function () {
                const styleSheets = nativeMethods.documentStyleSheetsGetter.call(this);

                return documentSandbox._shadowUI._filterStyleSheetList(styleSheets, styleSheets.length);
            },
        });

        const documentCookiePropOwnerPrototype = window[nativeMethods.documentCookiePropOwnerName].prototype;

        overrideDescriptor(documentCookiePropOwnerPrototype, 'cookie', {
            getter: () => documentSandbox._cookieSandbox.getCookie(),
            setter: value => documentSandbox._cookieSandbox.setCookie(String(value)),
        });

        overrideDescriptor(docPrototype, 'activeElement', {
            getter: function (this: Document) {
                const activeElement = nativeMethods.documentActiveElementGetter.call(this);

                if (activeElement && isShadowUIElement(activeElement))
                    return documentSandbox._shadowUI.getLastActiveElement() || this.body;

                return activeElement;
            },
        });

        if (this._documentTitleStorageInitializer && !partialInitializationForNotLoadedIframe) {
            overrideDescriptor(docPrototype, 'title', {
                getter: function () {
                    return documentSandbox._documentTitleStorageInitializer.storage.getTitle();
                },
                setter: function (value) {
                    documentSandbox._documentTitleStorageInitializer.storage.setTitle(value);
                },
            });
        }
    }
}
