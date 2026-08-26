/* tslint:disable */
/* eslint-disable */

export class PromiseHandle {
    free(): void;
    [Symbol.dispose](): void;
    adopt(other: PromiseHandle): boolean;
    constructor();
    reject(error: string): boolean;
    resolve(value: string): boolean;
    state(): string;
    value(): string;
}

export class Runtime {
    free(): void;
    [Symbol.dispose](): void;
    alias_namespace(alias: string, target: string): boolean;
    compileBytecodeArtifact(source: string): Uint8Array;
    /**
     * Compiles source into an HNW1 artifact whose generated module can be
     * instantiated by either Wasmtime or a browser WebAssembly engine.
     */
    compileWholeWasmArtifact(source: string): Uint8Array;
    /**
     * Creates the portable L0 evaluator without loading the language-level
     * foundation. This is useful for small embedded surfaces whose commands
     * only require core forms and should become interactive immediately.
     */
    static core(): Runtime;
    create_namespace(name: string): boolean;
    current_namespace(): string;
    eval(source: string): string;
    evalBytecodeArtifact(bytes: Uint8Array): string;
    eval_halc(bytes: Uint8Array): string;
    /**
     * Evaluates source after selecting a namespace.
     */
    eval_in_namespace(name: string, source: string): string;
    eval_traced(source: string): string;
    extension_available(name: string): boolean;
    file_delete(path: string): PromiseHandle;
    file_exists(path: string): PromiseHandle;
    file_list(path: string): PromiseHandle;
    file_mkdir(path: string): PromiseHandle;
    file_read(path: string): PromiseHandle;
    file_resolve(root: string, path: string): string;
    file_supported(): boolean;
    file_write(path: string, bytes: Uint8Array): PromiseHandle;
    /**
     * Returns whether a protocol method is registered in this runtime context.
     */
    has_protocol_method(protocol: string, method: string): boolean;
    /**
     * Installs the JS host handler that backs `std.native.Host/call`.
     */
    install_host_handler(handler: Function): void;
    install_loopback_socket_provider(): void;
    install_memory_file_provider(root: string): void;
    /**
     * Evaluates a registered resource in the current lexical namespace.
     */
    load_resource(name: string): string;
    constructor();
    /**
     * Registers a host-supplied Hara resource. Resources are source text, not executable host code.
     */
    register_resource(name: string, source: string): void;
    require_extension(name: string): string;
    /**
     * Loads a resource once; subsequent requires return the current loaded marker.
     */
    require_resource(name: string): string;
    require_resource_in_namespace(resource: string, namespace: string): string;
    resolve_namespace(name: string): string;
    socket_close(socket: bigint): void;
    /**
     * Opens a callback-based socket and returns its provider-owned handle.
     */
    socket_connect(host: string, port: number): bigint;
    socket_send(socket: bigint, bytes: Uint8Array): number;
    socket_supported(): boolean;
    use_namespace(name: string): boolean;
    visible_symbols(): string[];
}

/**
 * Browser-side owner for the dynamic Hara values referenced by a generated
 * whole-Wasm module. JavaScript supplies these methods as synchronous imports
 * while scalar and specialized aggregate work remains inside generated Wasm.
 */
export class WholeWasmHost {
    free(): void;
    [Symbol.dispose](): void;
    assocMapI64Pair(collection: bigint, outer_key: bigint, inner_key: bigint, value: bigint): bigint;
    beginCall(): void;
    boxI64(value: bigint): bigint;
    constantHandle(index: bigint): bigint;
    count(collection: bigint): bigint;
    getI64(collection: bigint, key: bigint): bigint;
    getPathI64Constants(collection: bigint, first_key: bigint, second_key: bigint): bigint;
    getValue(collection: bigint, key: bigint): bigint;
    isNumber(value: bigint): bigint;
    mapAssoc(map: bigint, key: bigint, value: bigint): bigint;
    mapEmpty(): bigint;
    mapI64Pair(key: bigint, value: bigint): bigint;
    constructor(bytes: Uint8Array);
    nth(collection: bigint, index: bigint): bigint;
    unboxI64(handle: bigint): bigint;
    vectorEmpty(): bigint;
    vectorPush(vector: bigint, item: bigint): bigint;
}

export function init_wasm(): void;

export function target_profile(): string;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_promisehandle_free: (a: number, b: number) => void;
    readonly __wbg_runtime_free: (a: number, b: number) => void;
    readonly __wbg_wholewasmhost_free: (a: number, b: number) => void;
    readonly init_wasm: () => void;
    readonly promisehandle_adopt: (a: number, b: number) => number;
    readonly promisehandle_new: () => number;
    readonly promisehandle_reject: (a: number, b: number, c: number) => number;
    readonly promisehandle_resolve: (a: number, b: number, c: number) => number;
    readonly promisehandle_state: (a: number, b: number) => void;
    readonly promisehandle_value: (a: number, b: number) => void;
    readonly runtime_alias_namespace: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly runtime_compileBytecodeArtifact: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_compileWholeWasmArtifact: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_core: () => number;
    readonly runtime_create_namespace: (a: number, b: number, c: number) => number;
    readonly runtime_current_namespace: (a: number, b: number) => void;
    readonly runtime_eval: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_evalBytecodeArtifact: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_eval_halc: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_eval_in_namespace: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly runtime_eval_traced: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_extension_available: (a: number, b: number, c: number) => number;
    readonly runtime_file_delete: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_file_exists: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_file_list: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_file_mkdir: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_file_read: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_file_resolve: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly runtime_file_supported: (a: number) => number;
    readonly runtime_file_write: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly runtime_has_protocol_method: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly runtime_install_host_handler: (a: number, b: number) => void;
    readonly runtime_install_loopback_socket_provider: (a: number) => void;
    readonly runtime_install_memory_file_provider: (a: number, b: number, c: number) => void;
    readonly runtime_load_resource: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_new: () => number;
    readonly runtime_register_resource: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly runtime_require_extension: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_require_resource: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_require_resource_in_namespace: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly runtime_resolve_namespace: (a: number, b: number, c: number, d: number) => void;
    readonly runtime_socket_close: (a: number, b: number, c: bigint) => void;
    readonly runtime_socket_connect: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly runtime_socket_send: (a: number, b: number, c: bigint, d: number, e: number) => void;
    readonly runtime_socket_supported: (a: number) => number;
    readonly runtime_use_namespace: (a: number, b: number, c: number) => number;
    readonly runtime_visible_symbols: (a: number, b: number) => void;
    readonly target_profile: (a: number) => void;
    readonly version: (a: number) => void;
    readonly wholewasmhost_assocMapI64Pair: (a: number, b: number, c: bigint, d: bigint, e: bigint, f: bigint) => void;
    readonly wholewasmhost_beginCall: (a: number) => void;
    readonly wholewasmhost_boxI64: (a: number, b: number, c: bigint) => void;
    readonly wholewasmhost_constantHandle: (a: number, b: number, c: bigint) => void;
    readonly wholewasmhost_count: (a: number, b: number, c: bigint) => void;
    readonly wholewasmhost_getI64: (a: number, b: number, c: bigint, d: bigint) => void;
    readonly wholewasmhost_getPathI64Constants: (a: number, b: number, c: bigint, d: bigint, e: bigint) => void;
    readonly wholewasmhost_getValue: (a: number, b: number, c: bigint, d: bigint) => void;
    readonly wholewasmhost_isNumber: (a: number, b: number, c: bigint) => void;
    readonly wholewasmhost_mapAssoc: (a: number, b: number, c: bigint, d: bigint, e: bigint) => void;
    readonly wholewasmhost_mapEmpty: (a: number, b: number) => void;
    readonly wholewasmhost_mapI64Pair: (a: number, b: number, c: bigint, d: bigint) => void;
    readonly wholewasmhost_new: (a: number, b: number, c: number) => void;
    readonly wholewasmhost_nth: (a: number, b: number, c: bigint, d: bigint) => void;
    readonly wholewasmhost_unboxI64: (a: number, b: number, c: bigint) => void;
    readonly wholewasmhost_vectorEmpty: (a: number, b: number) => void;
    readonly wholewasmhost_vectorPush: (a: number, b: number, c: bigint, d: bigint) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
