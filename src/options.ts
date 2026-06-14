/** Shared resolution of {@link AdapterOptions} → the engine-internal `opts` shape, so the three
 *  adapters apply the SAME defaults (no per-engine divergence). */
import type { AdapterOptions } from "./index.js";
import { SPRITE_PX, DEFAULT_SYMBOL_COLOR } from "./symbols.js";

/** `AdapterOptions` with the optional fields filled in (except `hitOverlays`, which stays optional). */
export type ResolvedAdapterOptions = Required<Omit<AdapterOptions, "hitOverlays">> & Pick<AdapterOptions, "hitOverlays">;

/** Apply the shared defaults (`spritePx` → {@link SPRITE_PX}, `defaultSymbolColor` →
 *  {@link DEFAULT_SYMBOL_COLOR}); `hitOverlays` is kept only when provided. */
export function resolveAdapterOptions(opts: AdapterOptions): ResolvedAdapterOptions {
  return {
    layers: opts.layers,
    spritePx: opts.spritePx ?? SPRITE_PX,
    defaultSymbolColor: opts.defaultSymbolColor ?? DEFAULT_SYMBOL_COLOR,
    ...(opts.hitOverlays ? { hitOverlays: opts.hitOverlays } : {}),
  };
}
