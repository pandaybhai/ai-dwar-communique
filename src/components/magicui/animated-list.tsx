import React, { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import { AnimatePresence, motion, useReducedMotion, type MotionProps } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * Magic UI's animated-list (magicui.design), restyled for AiDwar (Batch 44):
 * items arrive the way the preview's feed does — newest on top, sliding down
 * 12px into place — and under reduced motion every item shows at once.
 */
export function AnimatedListItem({ children }: { children: React.ReactNode }) {
  const animations: MotionProps = {
    initial: { opacity: 0, y: -12, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1, originY: 0 },
    exit: { opacity: 0, scale: 0.98 },
    transition: { duration: 0.5, ease: [0.2, 0.8, 0.2, 1] },
  };
  return (
    <motion.div {...animations} layout className="w-full">
      {children}
    </motion.div>
  );
}

export interface AnimatedListProps extends ComponentPropsWithoutRef<"div"> {
  children: React.ReactNode;
  /** Milliseconds between items. */
  delay?: number;
}

export const AnimatedList = React.memo(
  ({ children, className, delay = 1000, ...props }: AnimatedListProps) => {
    const reduce = useReducedMotion();
    const [index, setIndex] = useState(0);
    const childrenArray = useMemo(() => React.Children.toArray(children), [children]);

    useEffect(() => {
      if (reduce || index >= childrenArray.length - 1) return;
      const timeout = setTimeout(() => setIndex((i) => i + 1), delay);
      return () => clearTimeout(timeout);
    }, [index, delay, childrenArray.length, reduce]);

    const itemsToShow = useMemo(
      () => (reduce ? childrenArray : childrenArray.slice(0, index + 1)).slice().reverse(),
      [index, childrenArray, reduce],
    );

    return (
      <div className={cn("flex flex-col gap-2.5", className)} {...props}>
        <AnimatePresence initial={!reduce}>
          {itemsToShow.map((item) => (
            <AnimatedListItem key={(item as React.ReactElement).key}>{item}</AnimatedListItem>
          ))}
        </AnimatePresence>
      </div>
    );
  },
);

AnimatedList.displayName = "AnimatedList";
