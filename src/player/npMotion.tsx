import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

const spring = { type: "spring" as const, stiffness: 380, damping: 34, mass: 0.85 };
const soft = { type: "spring" as const, stiffness: 260, damping: 28 };

/** Harmonoid-style open container: slide up + fade from the player bar. */
export function NowPlayingShell({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="nb-np-shell"
          className="nb-np-motion-root"
          initial={
            reduce
              ? { opacity: 0 }
              : { opacity: 0, y: "12%", scale: 0.97, filter: "blur(8px)" }
          }
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          exit={
            reduce
              ? { opacity: 0 }
              : { opacity: 0, y: "8%", scale: 0.98, filter: "blur(6px)" }
          }
          transition={reduce ? { duration: 0.16 } : spring}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function MotionRail({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait">
      {open ? (
        <motion.aside
          key="nb-rail"
          className="nb-np-rail"
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: 28 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: 20 }}
          transition={reduce ? { duration: 0.14 } : soft}
          aria-label="Side panel"
        >
          {children}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

export function MotionLyricLine({
  active,
  past,
  children,
  onClick,
  lineRef,
}: {
  active: boolean;
  past: boolean;
  children: ReactNode;
  onClick?: () => void;
  lineRef?: (el: HTMLButtonElement | null) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      ref={lineRef}
      className={`nb-np-line${active ? " is-active" : ""}${past ? " is-past" : ""}`}
      onClick={onClick}
      animate={
        reduce
          ? undefined
          : {
              scale: active ? 1.06 : 1,
              opacity: active ? 1 : past ? 0.38 : 0.55,
              y: active ? 0 : 2,
            }
      }
      transition={soft}
    >
      {children}
    </motion.button>
  );
}

export function MotionCover({
  playing,
  className,
  children,
  onClick,
  label,
}: {
  playing: boolean;
  className?: string;
  children: ReactNode;
  onClick?: () => void;
  label?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      className={className}
      onClick={onClick}
      aria-label={label}
      animate={
        reduce
          ? undefined
          : playing
            ? { y: [0, -3, 0], scale: [1, 1.02, 1] }
            : { y: 0, scale: 1 }
      }
      transition={
        playing
          ? { duration: 4.5, repeat: Infinity, ease: "easeInOut" }
          : soft
      }
      whileTap={reduce ? undefined : { scale: 0.96 }}
    >
      {children}
    </motion.button>
  );
}
