import type { GlobalObject, RealmRecord } from './type';
import type { Utils } from '.';
import { testMode } from './helpers';

export function createRealmRecord(parentRealmRec: RealmRecord, utils: Utils) {
    const { document } = parentRealmRec.intrinsics;
    const iframe = document.createElement('iframe');
    iframe.name = 'ShadowRealm';
    document.head.appendChild(iframe);
    (iframe.contentWindow as any).testMode = testMode;
    const createInContext = (iframe.contentWindow as GlobalObject).eval(
        '(' + createRealmRecordInContext.toString() + ')'
    );
    return createInContext(utils);
}

function createRealmRecordInContext(utils: Utils) {
    const win = window;
    const { Function: RawFunction, Object, Symbol, testMode } = win as any;
    const { getOwnPropertyNames } = Object;
    const {
        apply,
        define,
        dynamicImportPattern,
        dynamicImportReplacer,
        replace,
    } = utils;
    const intrinsics = {} as GlobalObject;
    const globalObject = {} as GlobalObject;
    let UNDEFINED: undefined;

    if (Symbol && Symbol.unscopables) {
        // Prevent escape from the `with` environment
        define(globalObject, Symbol.unscopables, {
            value: Object.seal(Object.create(null)),
        });
    }

    /**
     * 获取回调函数只能在全局环境下调用的函数，如 setTimeout、setInterval
     *
     * @param {string} funcName 函数名称
     */
    function getGlobalCtxInvokedCallbackFunc(funcName: string) {
        return function (func: any) {
            const originFunc = func;
            const args = arguments;
            // 需要在全局下调用的函数
            const globalCtxInvokedFunc = intrinsics[funcName as any] as any;
            if (typeof originFunc === 'function') {
                args[0] = function () {
                    apply(originFunc, globalObject, arguments);
                };
            } else if (typeof originFunc === 'string') {
                args[0] = () => globalObject.eval(originFunc);
            }
            // 全局 window 调用对象可能已经被剔除，需要重置调用对象防止 Illegal invocation
            return apply(globalCtxInvokedFunc, undefined, args);
        };
    }

    const descriptorMap: Record<string, any> = {
        setTimeout: () => ({
            configurable: true,
            enumerable: true,
            value: getGlobalCtxInvokedCallbackFunc('setTimeout'),
            writable: true,
        }),
        setInterval: () => ({
            configurable: true,
            enumerable: true,
            value: getGlobalCtxInvokedCallbackFunc('setInterval'),
            writable: true,
        }),
        clearTimeout: () => ({
            configurable: true,
            enumerable: true,
            value: (timerId: number) =>
                apply(intrinsics.clearTimeout, undefined, [timerId]),
            writable: true,
        }),
        clearInterval: () => ({
            configurable: true,
            enumerable: true,
            value: (timerId: number) => {
                apply(intrinsics.clearInterval, undefined, [timerId]);
            },
            writable: true,
        }),
    };

    // Handle window object
    for (const key of getOwnPropertyNames(win) as any[]) {
        intrinsics[key] = win[key];
        const isReserved = utils.globalReservedProps.indexOf(key) !== -1;
        const descriptor = Object.getOwnPropertyDescriptor(win, key)!;
        if (!descriptor) continue;
        if (key === 'eval') {
            defineSafeEval();
        } else if (isReserved) {
            if (descriptorMap[key]) {
                const desc = descriptorMap[key]();
                define(globalObject, key, desc);
            } else {
                define(globalObject, key, descriptor); // copy to new global object
            }
        }
        if (testMode) continue;
        if (descriptor.configurable) {
            delete win[key];
        } else if (descriptor.writable) {
            win[key] = UNDEFINED as any;
        } else if (!isReserved) {
            // Intercept properties that cannot be deleted
            define(globalObject, key, { value: UNDEFINED });
        }
    }

    if (intrinsics.EventTarget) {
        // Intercept the props of EventTarget.prototype
        for (const key of getOwnPropertyNames(
            intrinsics.EventTarget.prototype
        )) {
            if (key !== 'constructor') {
                define(win, key, { value: UNDEFINED });
            }
        }
    }

    globalObject.globalThis = globalObject;
    globalObject.Function = createSafeFunction();

    const evalInContext = RawFunction('with(this)return eval(arguments[0])');
    const realmRec = { intrinsics, globalObject, evalInContext } as RealmRecord;

    utils.defineShadowRealmCtor(realmRec, utils);
    utils.addEsModuleHelpers(realmRec, utils);

    return realmRec;

    function defineSafeEval() {
        let isInnerCall = false;
        const safeEval = createSafeEval();
        define(globalObject, 'eval', {
            get() {
                if (isInnerCall) {
                    isInnerCall = false;
                    return intrinsics.eval; // used by safe eval
                }
                return safeEval;
            },
            set(val) {
                isInnerCall = val === intrinsics;
            },
        });
    }

    function createSafeEval() {
        return {
            eval(x: string) {
                // `'use strict'` is used to enable strict mode
                // `undefined`  is used to ensure that the return value remains unchanged
                x =
                    '"use strict";undefined;' +
                    replace(x, dynamicImportPattern, dynamicImportReplacer);
                utils.log(x);
                // @ts-ignore: `intrinsics` is the key to use raw `eval`
                globalObject.eval = intrinsics;
                return apply(evalInContext, globalObject, [x]);
            },
        }.eval; // fix: TS1215: Invalid use of 'eval'
    }

    function createSafeFunction(): FunctionConstructor {
        const { toString } = RawFunction;
        const Ctor = function Function() {
            const rawFn = apply(RawFunction, null, arguments);
            let fnStr = apply(toString, rawFn, []);
            fnStr = replace(fnStr, dynamicImportPattern, dynamicImportReplacer);
            fnStr =
                'with(this)return function(){"use strict";return ' +
                fnStr +
                '}()';
            utils.log(fnStr);
            const wrapFn = RawFunction(fnStr);
            const safeFn: Function = apply(wrapFn, globalObject, []);
            return function (this: any) {
                const ctx = this === win ? undefined : this;
                return apply(safeFn, ctx, arguments);
            };
        };
        Ctor.prototype = RawFunction.prototype;
        Ctor.prototype.constructor = Ctor;
        return Ctor as any;
    }
}
