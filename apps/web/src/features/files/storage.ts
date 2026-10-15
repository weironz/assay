import { api, apiOrigin } from "../../lib/api";

export interface FileEntry {
  name: string;
  directory: boolean;
  size: number;
  modified: number;
  blocked: boolean;
  shared?: boolean;
}
export interface FileStatus {
  connected: boolean;
  identity: { accountName: string; domain: string } | null;
  shares?: string[];
  expiresAt?: number;
  followsWebSession?: boolean;
  reconnectWithCompanyLogin?: boolean;
  maxFileBytes?: number;
}
export interface FileLocation {
  share: string;
  path: string;
}
export type FileCommand = FileLocation & {
  action: "mkdir" | "move" | "delete";
  destination?: string;
};
export const joinPath = (path: string, name: string) =>
  path ? `${path}/${name}` : name;
export const fileError = (error: unknown): string => {
  const message = (error as { response?: { data?: { message?: unknown } } })
    ?.response?.data?.message;
  return typeof message === "string"
    ? message
    : "请求未完成，请刷新核对文件状态后再试。";
};
export const sessionLost = (error: unknown) =>
  [401, 410].includes(
    (error as { response?: { status?: number } })?.response?.status || 0,
  );

/** The browser only holds locations and results. Session capabilities and SMB credentials stay on the server. */
export interface FileStorage {
  status(): Promise<FileStatus>;
  connect(password: string): Promise<FileStatus>;
  disconnect(): Promise<void>;
  list(location: FileLocation, signal: AbortSignal): Promise<FileEntry[]>;
  command(command: FileCommand): Promise<void>;
  upload(
    location: FileLocation,
    file: File,
    signal: AbortSignal,
    progress: (value: number) => void,
  ): Promise<void>;
  download(location: FileLocation): string;
}
export const storage: FileStorage = {
  status: async () => (await api.get<FileStatus>("/files/status")).data,
  connect: async (password) =>
    (await api.post<FileStatus>("/files/session", { password })).data,
  disconnect: async () => {
    await api.delete("/files/session");
  },
  list: async (params, signal) =>
    (await api.get<{ entries: FileEntry[] }>("/files/list", { params, signal }))
      .data.entries,
  command: async (command) => {
    await api.post("/files/commands", command);
  },
  upload: async (params, file, signal, progress) => {
    await api.put("/files/content", file, {
      params,
      signal,
      headers: { "Content-Type": "application/octet-stream" },
      onUploadProgress: (e) =>
        progress(
          e.total ? Math.min(100, Math.round((e.loaded * 100) / e.total)) : 0,
        ),
    });
  },
  download: (location) =>
    `${apiOrigin}/api/files/content?${new URLSearchParams({ ...location })}`,
};
