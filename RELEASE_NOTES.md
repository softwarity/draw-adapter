# Release Notes

## NEXT RELEASE

- **Add (a11y):** **in-card controls are now keyboard-operable + screen-reader friendly.** The picker
  trigger is a focusable `role="button"` with `aria-haspopup` (`menu` for flower/grid) and an
  `aria-label` from its value/`title`; **Enter/Space/↓** act (cycle or open), **↑** cycles back. Gauge
  and dial knobs are `role="slider"` with `aria-valuemin/max/now` (+ `aria-orientation`/`aria-label`),
  and **arrow keys step the value** by `step` (or 1% of the range), emitting like a drag. Decorative
  toolbar glyphs are `aria-hidden` (the button already carries the accessible name).

- **Internal:** shared `resolveAdapterOptions` (one set of defaults for the 3 engines, incl.
  `DEFAULT_SYMBOL_COLOR`), shared popup-chrome tokens (`chrome.ts`), `defaultCoordFormat` moved to a
  leaf to break the `index`↔`widget` import cycle, and consistency tidy-ups (OL `setTooltip` param,
  `FakeAdapter.addToolbar` signature). No behaviour change.

- **Fix (engines):** **`onViewChange` is single-slot — no listener leak on re-call.** Re-calling it used
  to add another `moveend` listener (OpenLayers) or orphan the previous one (MapLibre/Leaflet); now each
  adapter drops the prior handler before registering the new one (and OpenLayers cleans its key on
  `destroy`). Matches the existing `onPointer`/`onKey` single-slot behaviour.

- **Fix (toolbar):** the **snapshot button's icon-preview no longer leaks `window` key listeners** if the
  toolbar is torn down while the pointer is over the button (no `mouseleave` fires). The listeners are
  now scoped to an `AbortController` and self-clean once the button is detached.

- **Fix (widgets):** **card `padding` is decoupled from the frame.** Padding used to apply *only* to a
  framed card (`bg`/`border`), so a **bare** call-out could never space its content — edge buttons
  (`+`/`−`) sat on the text/glyph. Now padding applies when the card is framed (default `medium`, as
  before) **or** an explicit `padding` is given, while `bg`/`border` stay independent — so a bare card
  can be padded yet stay transparent/borderless. No regression: a card with no `padding` and no frame
  is still unpadded (`boxPadding(undefined)` is `medium`, so the absent case is guarded, not defaulted).

- **Add (toolbar):** **nested submenus (sub-sub-menus).** A submenu child that itself has `children`
  now becomes its own flyout, recursively. Each level opens on the **flipped axis** so the menus
  zig-zag (with a top/bottom bar: `bar (h) → submenu (v) → sub-submenu (h) → …`), and a nested trigger
  shows a chevron pointing the way its flyout opens. Hover-bridging across the gaps, click/touch open,
  sibling auto-collapse (one open path at a time, ancestors stay open) and outside-press close all work
  at any depth; picking any leaf collapses the whole cascade. Depth is unlimited in code — two levels is
  the practical UX limit. No API change: `ToolbarItem.children` was already recursive.

- **Add (widgets):** **`picker` control with three presentations that scale with option count.** The
  text `control: "carousel"` is renamed **`"picker"`** and gains a **`mode`**: `"carousel"` (default),
  `"flower"`, `"grid"`. Each mode **degrades** as choices grow so the control stays usable —
  `"carousel"`: a linear cycle (click/shift-click) for ≤5 options, a **flower** for 6–10, a **grid**
  beyond; `"flower"`: a **radial petal menu** (tap fans the petals out, pick one and it becomes the
  centre, re-tap the centre to re-open) up to 10, else a grid; `"grid"`: a grid popover always. The
  flower/grid popups live in `<body>` (`position:fixed`, JS-placed) so they're never clipped and sit
  above the map; an outside press closes them, and a press *between* petals falls through to the map.
  Selecting + drag-to-move are unchanged (the control is still a drag handle). The ≤5-option carousel is
  byte-for-byte the old behaviour. **Breaking:** `control: "carousel"` is removed (use `"picker"`), and
  `WidgetCarouselOption` is renamed `WidgetPickerOption`.

- **Add (widgets):** a `picker` renders **bold** so it reads as interactive — otherwise it looked
  identical to a static label. Bold (not an added glyph/chevron) keeps the value perfectly centred on
  the anchor. The accent colour stays the consumer's call: set `color` on the picker node (like the
  gauge/dial controls) so all editable elements share one cue (e.g. orange). The **flower petals and
  grid cells inherit that same cue** — bold + the accent ink (`currentColor`, so glyphs tint too) —
  and the selected/keyboard-focused marker uses the accent for **both** an accent ring **and** a light
  background tint (`color-mix` of the accent into white) instead of a fixed blue.

- **Add (widgets):** cards can take a **non-rectangular frame** via `boxShape` — `"rect"` (default),
  `"pentagon-up"`/`"pentagon-down"` ("house" shapes, point up/down, e.g. the tropopause label), or a
  custom **normalized polygon** (`number[][]`; `[0,0]`–`[1,1]` = content+padding box). A non-rect shape
  draws an **SVG frame** that follows the contour (`fill` = `bg`, `stroke` = `border` at `borderWidth`)
  — a CSS border can't bevel. The presets keep their point **inside** `[0,1]` (so it carries a text
  line — a "H" in the hat); a custom polygon may put points **outside** `[0,1]` to form a hollow
  cap/point, and the card then **grows to reserve** that overshoot so it's never clipped.
  `padding`/`font`/`origin`/drag/buttons are unchanged, and the SVG is `pointer-events:none` so it
  never blocks the card. `"rect"`/absent is the former CSS box (no regression).

- **Fix (widgets):** a **static `text` leaf now honours `\n`** (`white-space: pre-line`, like the
  picker) instead of collapsing to a single line, and **centres** its lines (`text-align: center`) so a
  short line (a `H`/`L`) sits under the FL rather than flush-left.

- **Add (widgets):** **`font.lineHeight`** (unitless, default `1.2`) on a card — lower it (≈1) to
  tighten multi-line labels.

- **Add (widgets):** a card's **border width is now a preset** (`borderWidth: "small" | "medium" |
  "large"`, reusing `TextBoxSize`) instead of a fixed 1px — no px exposed, consistent with
  `padding`/`radius`. `small` = 0.5px, `medium` = 1px (default, the former look), `large` = 2px. Applies
  only when `border` (colour) is set.

- **Add (overlays):** the **text-box (call-out label) border width is now a preset too** —
  `textBorderWidth: "small" | "medium" | "large"` on a `text` feature, honoured by **all three
  engines**. Resolves to 0.8 / 1.4 / 2.2px (a heavier scale than the card); **default `medium` = 1.4px**,
  matching the former MapLibre look — which also **unifies** the engines (OpenLayers/Leaflet were a thin
  1px before). MapLibre encodes it in the 9-slice box id (`__box|…|<borderWidth>`). `textBoxSize` /
  `textBoxRadius` unchanged.

- **Fix (widgets):** a **glyph picker trigger now honours `size`.** When the current option is a glyph
  (`svg`), the trigger gets a defined `size`-px box (default ~22px) instead of letting the inline svg
  fall back to its intrinsic size (e.g. 128px) — so a placed marker shown in picker mode is no longer
  oversized. Text-option pickers keep `fontSize` sizing; flower/grid popups are unchanged.

- **Add (widgets):** a picker option can carry a **`title`** used as its **tooltip** in the
  flower/grid and on the trigger — so a terse glyph value (`"CI"`) can hover as `"Cirrus"`. No `title`
  ⇒ **no tooltip** (no fallback to the label/value).

- **Fix (widgets):** **starting a card drag closes an open picker flower/grid.** A press elsewhere
  already closed it, but dragging the card *from the picker trigger* (which doubles as the drag handle)
  left the popup open/orphaned — now the drag start (`forwardDrag("down")`) collapses it first.

- **Add (widgets):** the picker **flower/grid are keyboard-navigable**. While open, the **arrow keys**
  browse the choices, **Enter**/**Space** picks the highlighted one, **Escape** closes — and the event
  is swallowed (capture) so it no longer reaches the map's native pan-on-arrow handler (you browse
  values, the map stays put).

---

## 0.3.4

- **Fix (widgets):** **the `dial` is now a true ring — its centre lets clicks through.** A map
  handle/feature rendered *at* the dial's centre (e.g. a jet break-point drag handle) now stays
  reachable underneath: a `pointerdown` in the hole falls through to the layer below instead of being
  swallowed by the widget. Two parts: (1) the dial itself exposes only an invisible **ring hit-area**
  (`pointer-events: stroke`, sized to the couronne) + the knob — its box, hole and corners opt out; and
  (2) **a lone-dial satellite card** (a card whose whole content is a dial — the break-point speed
  ring, centred on its anchor) opts the **whole card** out of pointer events. That second part is what
  actually makes the hole transparent: `pointer-events` inherits, so the card body, the layout box and
  the SVG all go transparent and only the ring/knob re-enable capture — otherwise the card body sitting
  behind the dial would keep swallowing the centre press. A dial sharing a card with other controls
  leaves that card interactive (its centre just hits the card body, as before). The transparent hole
  tracks the dial radius, and a press anywhere on the ring band now grabs the value (the whole couronne
  is interactive, not just the knob). DOM-only, so it holds on all 3 engines.

---

## 0.3.3

- **Add (widgets):** **`gauge` and `dial` value-editors** — two new `WidgetNode` kinds (the carousel's
  siblings, domain-free). A **`gauge`** is a linear slider (the vertical FL gauge) with **1–3 cursors**
  that may not cross (each clamped by its neighbours), `step` snapping, an optional one-notch `beyond`
  (the off-chart "XXX": emits `min - step` / `max + step`), a filled span between cursors, and
  per-cursor labels (consumer-formatted). A **`dial`** is a radial sweep (the jet speed control) with a
  fixed speedometer angle convention. Dragging a knob streams `onWidgetEdit({ id, name, value })` per
  move (string value), wired on **Pointer Events** (touch works) and never starting a card drag/pan;
  reconciled in place — a re-`setWidgets` won't interrupt a drag, and the cursor count can change
  (1↔3). The **dial label is a speedometer readout** — it follows the knob just outside the ring (at
  the knob's angle, never rotated so it stays upright), not pinned at the centre. Per-control styling
  with **map-ready defaults**: the guide is a **thin, well-marked central line** with a **wider faint
  same-colour glow on the *selected* part** (the gauge's span between cursors — extended a little past
  them, never min→max; the dial's arc from its start up to the value), labels are **black with a white
  1px halo**, and knobs are the control's **main colour with a white border** (all legible over the
  map out of the box) — `labelColor` /
  `labelHalo` / `knobFill` / `knobStroke` override any piece, and passing `""` opts it out (inherit /
  no halo / no border). New types `WidgetCursor` / `WidgetGauge` / `WidgetDial`;
  `FakeAdapter.dragGauge(id, name, value)`. **One shared DOM/SVG implementation** across all 3 engines.

---

## 0.3.2

- **Fix (focus · all engines):** after a click on a **toolbar button** or a **widget-card button**
  (action `+`, delete `×`, or a carousel), keyboard focus is returned to the map's key-listening
  element — so `onKey` keeps firing and **Escape can cancel a draw mode you just started** without
  first clicking the map. No-op while a widget `<input>` is focused (it keeps its caret). New
  `refocusMap(target)` in `keyboard.ts`; the toolbar and widget chrome call it after their action.
- **Fix (Leaflet):** an interactive **text label** now actually surfaces its click. Leaflet markers
  default to `bubblingMouseEvents: false`, so the (now-interactive) call-out **swallowed** the click
  before it reached `map.on("click")` — `leaflet-interactive` was present but no hit fired. The text
  marker is now created with `bubblingMouseEvents: true`, completing the 0.3.1 label-box fix: a real
  click on a non-selected feature's call-out selects it.

---

## 0.3.1

- **Add (widgets):** `"carousel"` control — a `text` item with `control: "carousel"` + `options`
  cycles values on **click** (next) / **shift-click** (previous) with a slide effect, emitting the
  new value via `onWidgetEdit({ id, name, value })`. A **tap also selects the card** (it emits the
  card's down/up/click, like tapping its body) and a **press-drag moves the card** (it doubles as a
  drag handle) — so the carousel area never blocks selecting or dragging. Options are **text or glyphs**
  (`["ISOL","OCNL","FRQ"]` or `[{ value, label?, svg? }]`); text honours `\n` (multi-line, centered). `onWidgetEdit` gains an optional `name`
  (also on the `<input>`) so a card with several editable controls knows which one changed.
  `FakeAdapter.editWidget(id, value, name?)`. New type `WidgetCarouselOption`; `WidgetText.control`
  is now `"input" | "carousel"` (+ `options`/`name`). Domain-free + additive — sigwx provides the
  options and reads the value back. (Plus `line-height` is pinned on the card so multi-line text is
  homogeneous across engines — MapLibre's container otherwise leaked a 20px line-height in.)
- **Fix (Leaflet):** a `text` feature's **label box (call-out) is now clickable** when its overlay
  is in `hitOverlays` — the text marker was always non-interactive, so clicking a non-selected label
  surfaced no hit (you couldn't select it). Non-hittable text stays pass-through (it never eats
  clicks meant for the shape beneath). Respects the `hitOverlays` contract; no API change.
- **Add (widgets):** `WidgetButton.title` and `deletable: { title }` render a **native tooltip**
  (the `title` attribute) on the action buttons and the delete `×`. `deletable` now accepts
  `boolean | { title }` (backward compatible).
- **Fix (MapLibre):** widget card **chrome buttons** (the delete `×` and `MarkerWidget.buttons`
  action buttons) plus the editable `<input>` didn't react to **real** mouse input on MapLibre.
  Its `Marker` (the widget mount) cancels `mousedown`, which makes the browser **suppress the
  synthesized `click`** for the whole gesture — so a real click on a card button did nothing (the
  consumer saw a no-hit map click and deselected), and click-to-focus on the input was lost. Chrome
  buttons now emit on a **local pointerup tap** (not the native click), and the input stops that
  compat `mousedown` — robust on all 3 engines. (jsdom/`dispatchEvent` doesn't reproduce the
  trusted-input suppression, so it warrants a real-browser/Playwright check.)
- **Fix (widgets):** the editable `<input>` now keeps **keyboard and caret** to itself — arrows /
  Home / End / Backspace no longer bubble to the engine and pan/zoom the map (the `input` event still
  fires, so editing is unaffected), and a click positions the caret **under the cursor** (the card's
  `user-select: none`, needed for card-drag, was cascading in and breaking caret placement / text
  selection — the input now forces `user-select: text`).

---

## 0.3.0

- **Add:** anchored **marker widgets** — a generic, domain-free DOM "card" pinned at a
  `lon/lat`, built from a tiny box-layout tree (vbox/hbox + `glyph` / `text` / `coord`),
  with an inline-editable `text` backed by a **real `<input>`** (caret, IME, paste, mobile
  keyboard) that **auto-grows** to its content. New `MapAdapter.setWidgets(MarkerWidget[])`
  (declarative, **diffed by `id`** like `setOverlay` — a focused input keeps its focus/caret
  across re-`setWidgets`), `onWidgetEdit({ id, value })` (per keystroke), and
  `setCoordFormat(fn)` (formats the live `coord` line). Selection/move **reuse the existing
  pointer model**: a card click/drag surfaces through `onPointer` as a
  `{ overlay: "widget", props: { id } }` hit (carrying the real lon/lat), and the card never
  drives map pan/zoom (an input press just edits). **One implementation across all three
  engines** — the card rides each engine's native anchored-overlay primitive (MapLibre
  `Marker` / OpenLayers `Overlay` / Leaflet `divIcon`), so it tracks per-frame through
  pan/zoom and stays screen-upright; Pointer Events ⇒ touch works. `padding`/`radius` reuse
  the `TextBoxSize`/`TextBoxRadius` presets. Implemented on all 3 engines + `FakeAdapter`
  (`.setWidgets`, `.onWidgetEdit`, `.editWidget(id, value)`, `.clickWidget(id)`). New types
  `MarkerWidget` / `WidgetBox` / `WidgetNode` / `WidgetGlyph` / `WidgetText` / `WidgetCoord` /
  `WidgetOrigin` / `WidgetEdit`; new export `defaultCoordFormat`. The `control` field is left
  open for future `gauge` / `dial` / `carousel` (only `input` now). **Purely additive** — no
  existing consumer is affected.
- **Add:** widgets can carry a **delete button** — `MarkerWidget.deletable: true` shows a bare
  `×` in the top-right corner that fires `MapAdapter.onWidgetDelete({ id })`; the lib never removes
  the card (the consumer drops the `id` from its next `setWidgets`). It's a separate element from
  the card body, so an **input-only card is still deletable**, and it's excluded from snapshots.
  Also new: `text.uppercase` — an editable input enters and emits its value in upper case
  (caret-preserved); a static label displays upper case.
- **Add:** `snapshot()` now **includes the widget cards** (in their static, non-editable form —
  each input rendered as its value) on **MapLibre and OpenLayers**, via a `foreignObject`
  composite. **Safe by design:** the card-less PNG is produced before any `foreignObject` is
  drawn, so a tainted canvas (e.g. on Safari) **degrades** to the card-less snapshot instead of
  failing. Leaflet `snapshot()` is still unsupported, so its widgets aren't captured yet.
- **Fix:** a `click` now carries the hit captured at its `down` (**atomic press**) instead of
  re-running the hit-test at click time — kills an intermittent **select → immediate-deselect**
  where the trailing `click` resolved to *no hit*: the select handler had re-rendered the feature
  (Leaflet drops its hover state, OpenLayers' `singleclick` is ~250 ms delayed and races the
  re-render). Two further nets fix the **first click after re-focusing the window** (whose `up`
  is often eaten by the OS focus gesture, leaving `dragging` stuck — which only cleared after a
  fresh map click): (a) a **move with no button held** finalises the press (emits the missing
  `up` + clears state) — it fires on the very move toward the element, before the click; and
  (b) window `blur` purges the press state. All 3 engines. Pure robustness — no API change.
- **Add:** `MapAdapter.onBlur(cb)` — fires when the map's **window loses focus** (the user
  switches to another window/app). The adapter stays domain-free and never changes selection
  itself; this is the signal so the consumer can **deselect** the active element (e.g. so a marker
  widget stops looking editable once you've left the window). All 3 engines + `FakeAdapter`
  (`.blur()` helper).
- **Fix (MapLibre + OpenLayers):** the `click` is now **synthesized from the release** (a
  `down`+`up` at one spot, reusing the `down` hit) instead of the engine's native click event —
  OL's was a debounced `singleclick` (~250 ms; a quick second click became a `dblclick`, so
  click-away-to-**deselect needed several clicks**), and MapLibre's native `click` gets **swallowed
  by the OS on the first click after re-focusing the window** (which produced a select→deselect on
  that click). Both now register on the **first** click, consistent with Leaflet. `dblclick` is
  unchanged (native). No API change.
- **Add (camera + container):** `getBounds()` (`[west, south, east, north]`), `getZoom()`,
  `getContainer()`, and `fitBounds([w,s,e,n], { padding? })` on all 3 engines + `FakeAdapter`.
  `fitBounds` **drives the host camera** (the one legit case — frame your own drawing); documented
  "use sparingly". (Audit #1 + #4.)
- **Add:** `setOverlayVisible(id, visible)` — show/hide an overlay layer **without dropping its
  data** (toggle reference layers / masks / guides); lossless vs. pushing an empty FC. (Audit #3.)
- **Add:** right-click → `onPointer` with `type: "contextmenu"` (the browser menu is suppressed),
  carrying the hit + lon/lat — e.g. finish a polygon / delete a vertex. All 3 engines + `FakeAdapter`
  (`send("contextmenu", …)`). (Audit #5.)
- **Add (widgets):** **action buttons** on the card edges/corners —
  `MarkerWidget.buttons: [{ event, place?, svg?, bordered? }]` fire `onWidgetAction({ id, event })`.
  `place` is an enum (`top`/`bottom`/`left`/`right` · the four corners · `edges`/`h-edges`/`v-edges`
  · `corners`/`top-corners`/`bottom-corners`/`left-corners`/`right-corners`) **or an array**, unioned
  and deduped (e.g. `["left-corners","top-corners"]` ⇒ 3 corners). Domain-free: the consumer names
  the `event` and decides what it does (e.g. "draw another area attached to this panel" ⇒ a
  multipolygon + a 2nd leader, all consumer-side). `FakeAdapter.actionWidget(id, event)`.
- **Add:** the `up` event now carries the **real release coordinate** on OpenLayers & Leaflet too
  (MapLibre already did) — finishing audit #2 (was `{0,0}`).
- **Change (cleanup):** `PointerEvent.hit` is now the exported `Hit` type instead of a duplicate
  inline shape — structurally identical, **non-breaking**. (Audit #8.)
- **Fix (MapLibre touch):** restored tap-to-select on touch — the release-synthesized click doesn't
  fire on a finger tap (no `mouseup`), so a deduped native-click fallback covers touch taps. (Note:
  freehand **drawing** on touch is still OpenLayers-only; ML/Leaflet drawing stays mouse-based — the
  remaining touch chantier #7.)

---

## 0.2.9

- **Add:** `PointerEvent` carries `ctrlKey`/`metaKey`/`shiftKey`/`altKey` (the live modifier
  state, incl. on `move`) on all 3 engines + `FakeAdapter` — lets consumers gate drag
  behaviour on a held modifier (e.g. Ctrl/⌘ to translate rigidly instead of deform). All
  optional + default `false` (non-breaking); `FakeAdapter.send(...)` takes an optional
  `mods` arg. Treat `ctrlKey || metaKey` as "the modifier" (Ctrl on PC/Linux, ⌘ on Mac).

---

## 0.2.8

- **Add:** per-feature **label box** controls on `text` features — `textBoxSize`
  (`small`/`medium`/`large`, default `medium`) for padding and `textBoxRadius`
  (`none`(default)/`small`/`medium`/`round`) for corners, on top of `textBackground` /
  `textBorder`. The box is drawn **only** when a fill and/or border is set, and **rotates
  with the text**. New exported types `TextBoxSize` / `TextBoxRadius`.
- **Fix/Add (MapLibre):** the label box is now a **per-feature** 9-slice image built on
  demand (`styleimagemissing`) from the feature's `textBackground`/`textBorder`/
  `textBoxSize`/`textBoxRadius` — so MapLibre finally honours per-feature box **colours**,
  padding and **corner radius** (it previously drew one fixed white/black box).
- **Limitation:** OpenLayers honours `textBoxSize` and the colours but **not**
  `textBoxRadius` — its native text background is a rectangle (no corner radius).

---

## 0.2.7

- **Add:** `MapAdapter.onKey(cb)` — forwards a normalized `KeyEvent` on keydown while the map is focused (scoped to the container, multi-instance safe; editable targets skipped). Raw transport — the consumer maps keys to actions (e.g. Delete/Backspace ⇒ remove selection). Implemented on all 3 engines + `FakeAdapter` (`.key()` helper); `bindKeyListener` exported.
- **Add:** toolbar **submenus** — a `ToolbarItem` with `children: ToolbarItem[]` becomes a flyout that opens on **hover** (desktop) and click (touch), *into the map* based on the toolbar edge (top ⇒ below · bottom ⇒ above · left ⇒ right · right ⇒ left). Two modes: **click** (parent = fixed category; a child runs its `onClick`) and **toggle** (`toggle: true`, a split button — the parent mirrors the selected child, becomes the active tool, and a parent click re-runs it). An outside press closes the flyout. `ToolbarItem.onClick` is now optional.
- **Add:** built-in **"lock map"** toggle at the end of the bar (default on; `ToolbarOptions.lock: false` hides it) — freezes pan/zoom/rotate on all 3 engines so the map can't move while drawing. New `MapAdapter.setInteractive(enabled)`: while locked it **wins** over the controller's transient `setPanEnabled`/`setDoubleClickZoom` (remembered and re-applied on unlock). New `ToolbarItem.standalone` (a utility button whose click doesn't change the active tool selection — also set on the snapshot button now).
- **Breaking:** removed `ToolbarOptions.orientation` — the bar's flow is now **derived from `position`** (top/bottom edge ⇒ horizontal row, left/right edge ⇒ vertical column), and the submenu flyout follows it (column vs row). Consumers must drop any `orientation` they passed.
- **Fix:** OpenLayers toolbar now renders as a solid white bar with plain buttons (OL's default `.ol-control` buttons were blue/translucent, so the bar looked like loose buttons).

---

## 0.2.6

- **Fix:** double-click editing (insert a shape vertex / split a break point) now works on **OpenLayers and Leaflet** — previously only MapLibre did. The capture-phase press handler that stops the map pan on a draggable hit was also suppressing the engine's *synthesized* `dblclick`, so it never reached the controller. OpenLayers now listens to the **native** viewport `dblclick` (its handles are canvas, so it fires reliably); Leaflet **detects the double-click manually** from press timing + position (its handle markers are recreated on every re-render, so the two clicks land on different DOM nodes and no native `dblclick` is emitted at all).
- **Add:** MapLibre **call-out boxes** — a 9-slice `icon-text-fit` background box drawn behind any label that carries `textBackground`, for parity with the native `backgroundFill` boxes on OpenLayers/Leaflet.
- **Change:** call-out box padding increased on OpenLayers and Leaflet; sprite glyphs in Leaflet `divIcon`s now scale to (and centre within) the icon box instead of sitting at their intrinsic size; Leaflet multi-line labels honour `\n` (`white-space: pre-line`).

---

## 0.2.5

- **Fix:** clipboard copy now works — the write is issued synchronously within the click (the capture promise is fed to `ClipboardItem`), instead of after the capture `await` where Safari/Chrome silently reject it (lost user gesture).
- Snapshot tooltip is now fixed per mode (e.g. *"Snapshot: click to file — ⌘+click to clipboard"*).

---

## 0.2.4

- `snapshot()` gains `hideOverlays?: string[]` — overlay ids to hide **only for the
  capture** (e.g. editing handles/guides), restored after, so the snapshot shows the
  clean drawing without the construction chrome. Also on the toolbar config
  (`snapshot: { hideOverlays: [...] }`).
- Removed the `basemap` snapshot option: hiding only the tiles can't be done cleanly in
  a generic, domain-free way (the host map's basemap vs. domain layers like FIR are
  indistinguishable, and the GL canvas isn't guaranteed transparent).

---

## 0.2.3

Adds a **curtain shutter effect** as capture feedback, plus clearer icons.

- A successful snapshot from the toolbar plays a brief shutter animation over the map —
  two translucent blades close to the centre and reopen (the map stays faintly visible) —
  visual confirmation that doubles as the *"copied"* feedback for the otherwise-silent
  clipboard delivery. Opt out with `snapshot: { shutter: false }` (default `true`).
- Honours `prefers-reduced-motion` (degrades to a single quick dim); the overlay is
  `pointer-events:none` and self-removes. The flash plays **only on success**.
- The snapshot button icon is a camera; the two deliveries differ only by the **lens** —
  filled for download (`SNAPSHOT_ICON_SVG`), an empty ring for clipboard
  (`SNAPSHOT_CLIPBOARD_ICON`) — and the hover preview swaps between them.
- New export `shutterFlash(container, { durationMs? })` for manual use.

---

## 0.2.2

Tidies the snapshot **toolbar option** — single object form, clearer naming.

- `ToolbarOptions.snapshot` is now `"none" | false | null | { quality?, onClick? }`
  (no more bare-preset string form). **`undefined` ⇒ defaults** (a button); any
  explicit falsy value (`null` / `false` / `"none"`) **hides** it.
- Renamed the size field `state` → **`quality`**, and the type `SnapshotLevel` →
  **`SnapshotQuality`** (`"native" | "low" | "medium" | "high"` — `"none"` moved out
  to the option's union, where it belongs).
- The toolbar button **live-previews the delivery while hovered**: holding the modifier
  key swaps its icon to the alternate action (the tooltip is fixed — see 0.2.5). Key
  listeners are scoped to the hover only (no global churn). New `ToolbarItem.onRender`
  hook + exported `SNAPSHOT_CLIPBOARD_ICON`.

---

## 0.2.1

Snapshot can now **download or copy to clipboard** — additive, non-breaking.

- `snapshot()` gains `target` (`"blob"` default · `"download"` · `"clipboard"`) and
  `filename`: it captures, optionally **delivers** the PNG, and always returns the Blob.
- Toolbar: one camera button now offers **both** deliveries. `ToolbarOptions.snapshot`
  accepts `{ state, onClick }` — `onClick` (`"download"` | `"clipboard"`, default
  `"download"`) is the plain-click delivery; the **other** runs on a modifier-click
  (Ctrl on PC/Linux, ⌘ on Mac). The string form (`snapshot: "high"`) still works.
- Clipboard uses the async Clipboard API (needs a secure context — HTTPS/localhost;
  the click is the required user gesture).
- New export `copyPng(blob)`; new `SnapshotTarget` / `SnapshotDelivery` types;
  `ToolbarItem.onClick` now receives the `MouseEvent` (for modifier keys).

---

## 0.2.0

Adds **PNG map snapshots** (basemap + overlays) — additive, non-breaking.

- `MapAdapter.snapshot(opts?: SnapshotOptions): Promise<Blob>` — always resolves to
  an `image/png` Blob. `scale` (output pixel-ratio) defaults to
  `window.devicePixelRatio`, i.e. captures "as on screen".
- **MapLibre** and **OpenLayers** are supported. Capture happens *inside the engine's
  render frame*, so the host map needs **no special flag** (no `preserveDrawingBuffer`).
- **Leaflet is not supported yet**: `snapshot()` rejects (tiles are `<img>`, overlays
  are SVG/DOM — no single exportable canvas). A DOM-snapshot approach is planned.
- Toolbar: new `ToolbarOptions.snapshot` preset — `"none" | "low" | "native" | "medium"
  | "high"` (default `"native"`). When set, `addToolbar` adds a camera button wired to
  download a PNG; on Leaflet the button is shown but **disabled** (the reason is its
  tooltip). Preset → output pixel-ratio via the exported `snapshotScale()`:
  `low → 1`, `native → devicePixelRatio`, `medium → 2`, `high → 3`. `medium`/`high`
  are supersampling — best-effort (a re-scale, not extra map detail).
- New exports: `snapshotScale`, `downloadPng`, `SNAPSHOT_ICON_SVG`, and the
  `SnapshotOptions` / `SnapshotLevel` types. `ToolbarItem` gains an optional `disabled`.

---

## 0.1.0

First release. Extracts the generic, data-driven map adapter from `sigwx-draw`
(the v2 design) into a standalone package shared by every @softwarity drawing lib.

- Generic `MapAdapter` interface — zero domain types; driven by a declarative
  `LayerSpec[]` manifest and a fixed feature render-prop contract.
- Three engine adapters: **MapLibre GL**, **OpenLayers**, **Leaflet** (new),
  rendering identically from the same baked feature props.
- Shared utilities: sprite atlas (`colorizeSprite`/`svgToDataUrl`/`loadSpriteImage`),
  toolbar (`populateToolbar`/`applyToolbarLayout`), tooltip (`applyTooltipStyle`),
  prop coercions (`rgba`/`num`/`str`/`deg2rad`/`wrapLabel`), `cursorForHit`.
- `FakeAdapter` (`./testing`) for unit-testing controllers without a map.
- Sub-path exports (`.`, `./maplibre`, `./openlayers`, `./leaflet`, `./testing`)
  with optional peer deps, so a consumer only pulls the engine(s) it uses.
- Carefully ported fixes: OpenLayers DragPan capture-phase guard + top-of-stack
  hit-testing; MapLibre lazy sprite/`data:` icon materialization + full teardown;
  homogeneous clockwise-degree icon rotation across all three engines.

---
