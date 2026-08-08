import { Fragment, forwardRef, type HTMLAttributes, type ReactNode } from "react";

type MotionProps = HTMLAttributes<HTMLDivElement> & {
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
  layout?: boolean | "position" | "size";
  layoutId?: string;
  whileTap?: unknown;
  whileHover?: unknown;
};
const OMIT = new Set(["initial", "animate", "exit", "transition", "layout", "layoutId", "whileTap", "whileHover"]);

const Div = forwardRef<HTMLDivElement, MotionProps>(function MotionDiv(props, ref) {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!OMIT.has(key)) clean[key] = value;
  }
  return <div ref={ref} {...(clean as HTMLAttributes<HTMLDivElement>)}>{props.children}</div>;
});

export const m = { div: Div };
export const domAnimation = {};
export function AnimatePresence({ children }: { children?: ReactNode; initial?: boolean; mode?: "sync" | "wait" | "popLayout" }) { return <Fragment>{children}</Fragment>; }
export function LazyMotion({ children }: { children?: ReactNode; features?: unknown; strict?: boolean }) { return <Fragment>{children}</Fragment>; }
export function MotionConfig({ children }: { children?: ReactNode; reducedMotion?: "always" | "never" | "user"; transition?: unknown }) { return <Fragment>{children}</Fragment>; }
