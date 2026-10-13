// Types shared by main.js, the shell and every screen. No code: this file exists so the JSDoc typedefs have one home.

/** @typedef {import("./route.js").Route} Route */
/** @typedef {typeof import("./copy.js").copy} Copy */
/** @typedef {ReturnType<typeof import("../net/fleet.js").createFleet>} Fleet */

/** `ctx.settings`: the one JSON object under `porthole:settings`; keys that were never saved are absent. @typedef {Record<string, unknown>} Settings */
/** @typedef {{get(): Settings, set(patch: Settings): void, subscribe(fn: (s: Settings) => void): () => void}} SettingsStore */

/**
 * The Android app's native bridge (`PortholeNative`). What a call resolves to is the app's own JSON (`null` in a plain browser), so
 * the caller narrows it.
 * @typedef {{available: boolean, call(method: string, args?: unknown): Promise<unknown>, on(event: string, fn: (data: unknown) => void): () => void}} Bridge
 */

/** The app event bus (`ctx.events`). @typedef {{on(name: string, fn: (data: unknown) => void): () => void, emit(name: string, data: unknown): void}} Events */

/**
 * What the shell hands a screen when it mounts it.
 * @typedef {object} Ctx
 * @property {Fleet} fleet
 * @property {SettingsStore} settings
 * @property {Bridge} bridge
 * @property {Copy} copy
 * @property {Events} events
 * @property {Route} route
 * @property {(target: string | Route) => void} navigate
 * @property {(name: string, state: import("../net/socket.js").LinkState, retry?: () => void) => () => void} reportLink
 */

export {};
