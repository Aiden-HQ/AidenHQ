// An agent's face: its bundled portrait, or a generated monogram (avatar.ts) when it has none or the portrait fails to load.
// Never a broken image box. Size comes from `size` or, without it, from the class (e.g. .avatar in a crew row).
import { useState } from "react";
import { faceOf } from "./avatar";

export function AgentAvatar({ name, portrait, size, className = "", front, title }: { name: string; portrait?: string; size?: number; className?: string; front?: boolean; title?: string }) {
  const [failed, setFailed] = useState<string | undefined>();
  const face = faceOf(name, portrait, failed === portrait);
  const dims = size ? { width: size, height: size } : {};
  if (face.kind === "portrait")
    return <img className={`agent-face portrait ${className}`} src={face.src} alt="" title={title} {...dims} style={size ? dims : undefined} draggable={false} onError={() => setFailed(portrait)} />;
  return (
    <svg className={`agent-face mono tone-${face.tone}${front ? " front" : ""} ${className}`} viewBox="0 0 40 40" {...dims} style={size ? dims : undefined} role="img" aria-label={title ?? name}>
      {title && <title>{title}</title>}
      <circle cx="20" cy="20" r="20" />
      <text x="20" y="20" dy="0.35em" textAnchor="middle" fontSize={face.text.length > 1 ? 15 : 18}>
        {face.text}
      </text>
    </svg>
  );
}
