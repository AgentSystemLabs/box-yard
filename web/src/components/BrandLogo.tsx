import { cx } from "./ui"

// The Y of YARD is the logo's crate (web/public/icons/box-yard-icon.svg) at cap height, with the wordmark's own Y cut out
// of it where the crate has its Y-shaped gap: a light top, an amber plank and a dark plank, in the logo's order. The
// gap is empty, so the Y is whatever is behind the wordmark. scripts/wordmark-font.py cuts these from Sora's Y and
// prints them; the square's corners are rounded by a clip, like the logo's (70 of 256).
const CRATE_Y = [
  { d: "M543.5 0 394.5 343.5 356.5 343.5 193.5 0Z", fill: "#fcd34d" },
  { d: "M0 730 0 0 47.5 0 267 451 303 451 303 730Z", fill: "#f59e0b" },
  { d: "M730 0 730 730 442 730 442 451 478 451 681.5 0Z", fill: "#b45309" },
]

/** The crate Y sits on the text's baseline, with a 10% optical enlargement around its center to balance the letters. */
function CrateY() {
  return (
    <svg
      viewBox="0 0 730 730"
      aria-hidden
      className="mx-[0.04em] inline-block h-[0.73em] w-[0.73em] scale-110 align-baseline [clip-path:inset(0_round_27.34%)]"
    >
      {CRATE_Y.map((piece) => (
        <path key={piece.fill} d={piece.d} fill={piece.fill} />
      ))}
    </svg>
  )
}

/** Box Yard's logo: the "BOX YARD" wordmark, whose Y is the crate. There's no separate mark beside it. */
export function BrandLogo({ className, textClassName = "text-base text-zinc-50" }: { className?: string; textClassName?: string }) {
  // The wordmark sits in its own container, so the logo takes the width its row gives it (flex-1 in a row with buttons).
  return (
    <div className={cx("flex min-w-0 items-center", className)}>
      {/* Its own face (styles.css): Sora SemiBold, holding just these capitals, tracked a little with a wider word space.
          In a row too tight for it (a 200px sidebar beside its buttons) it steps down, to 14px and then 12.5px at the
          default size, rather than cut short. The steps are in em, so they follow the text size, and the spacing sits
          on the inner span, so it shrinks with them. Screen readers get the name, not the letters and a picture. */}
      <span className={cx("@container/wordmark min-w-0 flex-1 font-wordmark font-semibold", textClassName)}>
        <span className="sr-only">Box Yard</span>
        <span
          aria-hidden
          className="block truncate tracking-[0.02em] [word-spacing:0.12em] @max-[5.875em]/wordmark:text-[0.875em] @max-[5.125em]/wordmark:text-[0.78125em]"
        >
          BOX <CrateY />
          ARD
        </span>
      </span>
    </div>
  )
}
