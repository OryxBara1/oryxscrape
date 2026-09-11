import { cn } from "@/lib/utils";

/**
 * 21st.dev — ravikatiyar162/glowing-card.
 * The registry ships this markup with HTML `class` attributes (not valid TSX)
 * and hardcoded demo content; converted to JSX and made data-driven while
 * keeping the original DOM structure and class names intact.
 */
export const Component = ({
  value = "750k",
  label = "Views",
  className,
}: {
  value?: React.ReactNode;
  label?: React.ReactNode;
  className?: string;
}) => {
  return (
    <div className={cn("glowing-card", className)}>
      <div className="outer">
        <div className="dot" />
        <div className="card">
          <div className="ray" />
          <div className="text">{value}</div>
          <div>{label}</div>
          <div className="line topl" />
          <div className="line leftl" />
          <div className="line bottoml" />
          <div className="line rightl" />
        </div>
      </div>
    </div>
  );
};

export { Component as GlowingCard };
