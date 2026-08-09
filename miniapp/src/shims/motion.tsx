import {
  Children,
  Fragment,
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

type MotionValue = string | number;
type MotionStyle = CSSProperties & {
  x?: MotionValue;
  y?: MotionValue;
  scale?: number;
  rotate?: MotionValue;
};

type MotionTransition = {
  duration?: number;
  delay?: number;
  ease?: string | readonly number[];
};

type MotionProps = Omit<HTMLAttributes<HTMLDivElement>, "style"> & {
  style?: CSSProperties;
  initial?: MotionStyle | false;
  animate?: MotionStyle;
  exit?: MotionStyle;
  transition?: MotionTransition;
  layout?: boolean | "position" | "size";
  layoutId?: string;
  whileTap?: unknown;
  whileHover?: unknown;
  __tigamePresencePhase?: "present" | "exit";
  __tigameSkipInitial?: boolean;
};

const OMIT = new Set([
  "initial",
  "animate",
  "exit",
  "transition",
  "layout",
  "layoutId",
  "whileTap",
  "whileHover",
  "__tigamePresencePhase",
  "__tigameSkipInitial",
]);

function toLength(value: MotionValue | undefined) {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}px` : value;
}

function toAngle(value: MotionValue | undefined) {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}deg` : value;
}

function motionStyle(base: CSSProperties | undefined, value: MotionStyle | undefined): CSSProperties {
  if (!value) return base ?? {};
  const next: Record<string, unknown> = { ...(base ?? {}) };
  const transform: string[] = [];
  if (base?.transform) transform.push(base.transform);
  if (value.x !== undefined || value.y !== undefined) {
    transform.push(`translate3d(${toLength(value.x) ?? "0px"}, ${toLength(value.y) ?? "0px"}, 0)`);
  }
  if (value.scale !== undefined) transform.push(`scale(${value.scale})`);
  if (value.rotate !== undefined) transform.push(`rotate(${toAngle(value.rotate)})`);

  for (const [key, item] of Object.entries(value)) {
    if (key === "x" || key === "y" || key === "scale" || key === "rotate") continue;
    next[key] = item;
  }
  if (transform.length > 0) next.transform = transform.join(" ");
  return next as CSSProperties;
}

function easing(value: MotionTransition["ease"]) {
  if (Array.isArray(value) && value.length === 4) return `cubic-bezier(${value.join(",")})`;
  if (typeof value === "string") return value;
  return "cubic-bezier(0.22,1,0.36,1)";
}

function transitionMs(value: MotionTransition | undefined) {
  return Math.max(0, Math.round((value?.duration ?? 0.28) * 1000));
}

function transitionStyle(value: MotionTransition | undefined): CSSProperties {
  return {
    transitionProperty: "opacity, transform, height, margin, padding, background-color, border-color",
    transitionDuration: `${transitionMs(value)}ms`,
    transitionDelay: `${Math.max(0, Math.round((value?.delay ?? 0) * 1000))}ms`,
    transitionTimingFunction: easing(value?.ease),
  };
}

const Div = forwardRef<HTMLDivElement, MotionProps>(function MotionDiv(props, ref) {
  const {
    children,
    style,
    initial,
    animate,
    exit,
    transition,
    __tigamePresencePhase = "present",
    __tigameSkipInitial = false,
  } = props;
  const canEnter = initial !== false && Boolean(initial) && !__tigameSkipInitial;
  const [entered, setEntered] = useState(!canEnter);

  useEffect(() => {
    if (!canEnter) return;
    const timer = window.setTimeout(() => setEntered(true), 16);
    return () => window.clearTimeout(timer);
  }, [canEnter]);

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key !== "children" && key !== "style" && !OMIT.has(key)) clean[key] = value;
  }

  const enterStyle = initial === false ? undefined : initial;
  const target = __tigamePresencePhase === "exit" && exit
    ? exit
    : (!entered ? enterStyle : animate);
  const resolvedStyle = {
    ...motionStyle(style, target),
    ...transitionStyle(transition),
  };

  return (
    <div ref={ref} {...(clean as HTMLAttributes<HTMLDivElement>)} style={resolvedStyle}>
      {children}
    </div>
  );
});

function singleElement(children: ReactNode): ReactElement<MotionProps> | null {
  if (isValidElement(children)) return children as ReactElement<MotionProps>;
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<MotionProps>[];
  return items.length === 1 ? items[0] : null;
}

function WaitPresence({ children, initial }: { children?: ReactNode; initial?: boolean }) {
  const next = singleElement(children);
  const nextKey = next?.key ?? null;
  const [displayed, setDisplayed] = useState<ReactElement<MotionProps> | null>(next);
  const [phase, setPhase] = useState<"present" | "exit">("present");
  const [hasSwitched, setHasSwitched] = useState(false);
  const pendingRef = useRef<ReactElement<MotionProps> | null>(next);
  const latestPresentedRef = useRef<ReactElement<MotionProps> | null>(next);
  const exitTimerRef = useRef<number | undefined>(undefined);
  const displayedKey = displayed?.key ?? null;

  // Store refs only after commit. `pendingRef` keeps the newest destination if room state
  // changes while an exit animation is already running.
  useEffect(() => {
    pendingRef.current = next;
    if (phase === "present" && displayedKey === nextKey) latestPresentedRef.current = next;
  }, [displayedKey, next, nextKey, phase]);

  // Keep the retained element current for a future exit, without blocking normal same-key updates.
  useEffect(() => {
    if (phase !== "present" || displayedKey !== nextKey || displayed === next) return;
    const timer = window.setTimeout(() => setDisplayed(next), 0);
    return () => window.clearTimeout(timer);
  }, [displayed, displayedKey, next, nextKey, phase]);

  // `mode="wait"`: play the old child's exit transition, then mount the latest pending key.
  useEffect(() => {
    if (phase !== "present" || displayedKey === nextKey) return;
    const startTimer = window.setTimeout(() => {
      setHasSwitched(true);
      const current = latestPresentedRef.current ?? displayed;
      if (!current) {
        setDisplayed(pendingRef.current);
        return;
      }
      setDisplayed(current);
      setPhase("exit");
      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = undefined;
        setDisplayed(pendingRef.current);
        setPhase("present");
      }, transitionMs(current.props.transition));
    }, 0);
    return () => window.clearTimeout(startTimer);
  }, [displayed, displayedKey, nextKey, phase]);

  useEffect(() => () => {
    if (exitTimerRef.current !== undefined) window.clearTimeout(exitTimerRef.current);
  }, []);

  const visible = phase === "present" && displayedKey === nextKey ? next : displayed;
  if (!visible) return null;
  return cloneElement(visible, {
    __tigamePresencePhase: phase === "exit" ? "exit" : "present",
    __tigameSkipInitial: !hasSwitched && initial === false,
  });
}

export const m = { div: Div };
export const domAnimation = {};

export function AnimatePresence({
  children,
  initial,
  mode,
}: {
  children?: ReactNode;
  initial?: boolean;
  mode?: "sync" | "wait" | "popLayout";
}) {
  if (mode === "wait") return <WaitPresence initial={initial}>{children}</WaitPresence>;
  return <Fragment>{children}</Fragment>;
}

export function LazyMotion({ children }: { children?: ReactNode; features?: unknown; strict?: boolean }) {
  return <Fragment>{children}</Fragment>;
}

export function MotionConfig({ children }: { children?: ReactNode; reducedMotion?: "always" | "never" | "user"; transition?: unknown }) {
  return <Fragment>{children}</Fragment>;
}
