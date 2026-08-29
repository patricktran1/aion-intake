/**
 * Wordmark. Two weights of the same word plus a hairline rule — the mark should
 * feel like a letterhead, not a logo.
 */
export function Brand({ size = "md" }: { size?: "sm" | "md" }) {
  const text = size === "sm" ? "text-[15px]" : "text-lg";
  return (
    <span className={`${text} tracking-[0.16em] uppercase`}>
      <span className="font-semibold text-ink">AION</span>
      <span className="text-muted"> Intake</span>
    </span>
  );
}
