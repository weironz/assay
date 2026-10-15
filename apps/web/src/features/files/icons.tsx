import type { SVGProps } from "react";

type IconName =
  | "back"
  | "chevron"
  | "grid"
  | "list"
  | "search"
  | "refresh"
  | "upload"
  | "plus"
  | "more"
  | "download"
  | "move"
  | "trash"
  | "close";
const paths: Record<IconName, string> = {
  back: "m12 5-7 7 7 7M5 12h14",
  chevron: "m9 5 7 7-7 7",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  refresh:
    "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2l1 4M4 12l1 4a8 8 0 0 0 13 2",
  upload: "M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5",
  plus: "M12 5v14M5 12h14",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  download: "M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4",
  move: "M4 4h6v6H4zM14 14h6v6h-6zM14 4h6v6m0-6L9 15",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  close: "m6 6 12 12M6 18 18 6",
};
export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function FileIcon({
  name,
  directory,
  shared,
  className = "",
}: {
  name: string;
  directory: boolean;
  shared?: boolean;
  className?: string;
}) {
  if (directory)
    return (
      <svg
        viewBox="0 0 96 80"
        fill="none"
        aria-hidden="true"
        className={className}
      >
        <path
          d="M6 15a7 7 0 0 1 7-7h23l10 11h37a7 7 0 0 1 7 7v40a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z"
          fill="#8eb5f3"
        />
        <path
          d="M6 30a7 7 0 0 1 7-7h70a7 7 0 0 1 7 7v36a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z"
          fill="#a9c7fa"
        />
        {shared && (
          <g
            transform="translate(37 39)"
            stroke="#4777c0"
            strokeWidth="2.4"
            strokeLinecap="round"
          >
            <circle cx="8" cy="6" r="4" />
            <path d="M0 24v-3a8 8 0 0 1 16 0v3M18 2a4 4 0 0 1 0 8M21 14a7 7 0 0 1 4 7v3" />
          </g>
        )}
      </svg>
    );
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const tone = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)
    ? "#8056c5"
    : ["xlsx", "xls", "csv"].includes(ext)
      ? "#31845a"
      : ext === "pdf"
        ? "#c65353"
        : ["zip", "gz", "7z", "tar", "rar"].includes(ext)
          ? "#a47b37"
          : "#527fae";
  return (
    <svg
      viewBox="0 0 80 80"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M19 5h28l17 17v47a6 6 0 0 1-6 6H19a6 6 0 0 1-6-6V11a6 6 0 0 1 6-6"
        fill="currentColor"
        className="text-white dark:text-gray-800"
        stroke="#cad3df"
        strokeWidth="1.5"
      />
      <path d="M47 5v12a5 5 0 0 0 5 5h12" stroke="#cad3df" strokeWidth="1.5" />
      <rect x="5" y="39" width="55" height="23" rx="4" fill={tone} />
      <text
        x="32.5"
        y="54"
        textAnchor="middle"
        fontSize="11"
        fontFamily="system-ui, sans-serif"
        fontWeight="600"
        fill="white"
      >
        {(ext || "FILE").slice(0, 5).toUpperCase()}
      </text>
    </svg>
  );
}
