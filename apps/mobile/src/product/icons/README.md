# Hugeicons Animated

MIT source: https://github.com/enesgules/hugeicons-animated at cd1eeed1b51eac9aa65f58ef6663e49fc2310ca9. License retained here.

`upstream/` retains the original per-part Motion animations. Only local imports and the animation hook cleanup are adapted; stop now cancels finite as well as looping animation. `HugeIcon.web.tsx` binds the imperative handle to the containing control so hover/focus/touch/click work across its whole target, respects reduced motion and removes listeners on unmount. No runtime remote SVG is fetched.

`geometry.ts` is the native resting representation. Pending circular indicators use the official circle-check ring without its check; they must not imply completion. `icons.tsx` is the application's icon vocabulary; there is no Lucide fallback.
