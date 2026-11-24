// The board's navigation icons: 16px, 1.5 stroke, currentColor. One path set each, drawn for this board.
const paths = {
  chat: "M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5z",
  approvals: "M8 1.8 13 4v3.6c0 3-2.1 5.3-5 6.6-2.9-1.3-5-3.6-5-6.6V4zM5.6 8l1.7 1.7L10.5 6.4",
  tasks: "M2.5 3.5h3v9h-3zM6.5 3.5h3v6h-3zM10.5 3.5h3v4h-3z",
  agents: "M8 7.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM3.2 13.6c.5-2.4 2.4-4 4.8-4s4.3 1.6 4.8 4",
  apps: "M2.8 2.8h4.4v4.4H2.8zM8.8 2.8h4.4v4.4H8.8zM2.8 8.8h4.4v4.4H2.8zM8.8 8.8h4.4v4.4H8.8z",
  modules: "M8 1.8 13.6 5 8 8.2 2.4 5zM2.4 8 8 11.2 13.6 8M2.4 11 8 14.2l5.6-3.2",
  reviews: "M4.5 2.5v6M4.5 8.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11.5 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11.5 7.5c0 3-3 3-5.5 4.6",
  costs: "M2.5 13.5h11M4 11V8M7 11V5M10 11V7M13 11V3.5",
  flow: "M2.5 4.5h6M2.5 8h9M2.5 11.5h4M10.5 3l2 1.5-2 1.5M13.5 10l-2 1.5 2 1.5",
  settings: "M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6",
  help: "M8 14.2A6.2 6.2 0 1 0 8 1.8a6.2 6.2 0 0 0 0 12.4zM6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.3M8 11.3v.1",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14",
  external: "M6.5 3.5h-3v9h9v-3M9 3h4v4M13 3 7.5 8.5",
  plus: "M8 3v10M3 8h10",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  bell: "M4 11V7a4 4 0 1 1 8 0v4l1 1.5H3zM6.6 14h2.8",
  brief: "M3.5 2.5h9v11h-9zM5.5 5.5h5M5.5 8h5M5.5 10.5h3",
  back: "M10 3 5 8l5 5",
  // For module pages (modules/board/schemas/pages.json lists the names a page may use).
  rocket: "M9.5 2.5c2.2.2 3.8 1.8 4 4L9 11 5 7zM5 7 2.8 7.4 2 9.5l2.3.2M9 11l-.4 2.2-2.1.8-.2-2.3M4.3 11.7 2.5 13.5",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01",
  terminal: "M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5",
  phone: "M5 1.8h6a1 1 0 0 1 1 1v10.4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1zM7 12.2h2",
  stop: "M4.5 4.5h7v7h-7z",
  refresh: "M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.6h-2.6",
  shield: "M8 1.8 13 4v3.6c0 3-2.1 5.3-5 6.6-2.9-1.3-5-3.6-5-6.6V4z",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const round = name === "more";
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth={round ? 2.4 : 1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}
