// A button, or a link that looks like one (pass href). One primary action per view; quiet for the least important.
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "default" | "primary" | "danger" | "quiet";

export function buttonClass(variant: ButtonVariant = "default", size?: "sm") {
  return `btn${variant === "default" ? "" : ` ${variant}`}${size ? ` ${size}` : ""}`;
}

export function Button({ variant, size, className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" }) {
  return <button type={type} className={`${buttonClass(variant, size)}${className ? ` ${className}` : ""}`} {...rest} />;
}

/** A link from server data runs nothing: web, in-page and same-origin addresses only. */
export function safeHref(href: string) {
  return /^(https?:\/\/|#|\/(?!\/))/i.test(href) ? href : "#";
}

export function LinkButton({ variant, size, href, children, external }: { variant?: ButtonVariant; size?: "sm"; href: string; children: React.ReactNode; external?: boolean }) {
  return (
    <a className={buttonClass(variant, size)} href={safeHref(href)} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}>
      {children}
    </a>
  );
}
