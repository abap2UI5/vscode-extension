/*
 * The settings namespace, in one place.
 *
 * Every abap2UI5 setting lives under this prefix and every command id starts
 * with it, so it appeared as a private `const CONFIG_SECTION = "abap2ui5"` in
 * eight modules. Nothing would have failed to compile if one of them drifted -
 * that module would simply have read settings nobody writes.
 *
 * Its own module rather than `session.ts`, which exported it first: the web
 * build's check needs it too, and importing it from the session would pull the
 * proxy and everything else desktop-only into the browser bundle.
 */

export const CONFIG_SECTION = "abap2ui5";
