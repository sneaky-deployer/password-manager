import { cn } from "../../lib/cn.ts";
import { avatarColor, avatarLetter } from "./item-utils.ts";

/** Coloured letter avatar. No favicons: fetching them would tell the site it is in your vault. */
export function Avatar({
  name,
  readable = true,
  className,
}: {
  name: string;
  readable?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg font-semibold text-white",
        readable ? avatarColor(name) : "bg-slate-400 dark:bg-slate-600",
        className,
      )}
    >
      {readable ? avatarLetter(name) : "!"}
    </span>
  );
}
