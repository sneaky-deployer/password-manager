import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";
import { inputClasses } from "./Input.tsx";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(inputClasses, "pr-8", className)} {...rest}>
        {children}
      </select>
    );
  },
);
