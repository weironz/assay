import { useState, type SVGProps } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import CopOverview from "../features/cop/Overview";
import {
  BUSINESS_MODULES,
  PLATFORM_MODULE,
  allowedItems,
  moduleHome,
} from "../lib/business-navigation";
import { useAuth } from "../stores/auth";
import { useModules } from "../stores/modules";
import { storage } from "../features/files/storage";
import { fileHref } from "../features/files/locations";
import { FileIcon, Icon } from "../features/files/icons";
import { localeOf } from "../i18n";

const symbols: Record<string, string> = {
  tickets: "M9 5h6M9 10h6M9 15h4M6 3h12v18H6z",
  assets: "m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9",
  spares: "M3 3h18v5H3zM5 8v13h14V8M9 12h6",
  files: "M3 7V4h6l3 3h9v13H3V7Z",
  platform: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4ZM8 12l3 3 5-6",
  account: "M20 21v-2a8 8 0 0 0-16 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
};
function ServiceIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={symbols[name] || symbols.tickets} />
    </svg>
  );
}
const surface =
  "rounded-2xl border border-gray-200/80 bg-white dark:border-gray-800 dark:bg-gray-900";

export default function PlatformOverviewPage() {
  const { t, i18n } = useTranslation();
  const { user, has } = useAuth();
  const features = useModules((s) => s.features);
  const [search, setSearch] = useState("");
  const [today] = useState(() => new Date());
  const files = useQuery({
    queryKey: ["workbench-files", user?.id],
    queryFn: () => storage.status(),
    enabled: features.files && !!user,
    staleTime: 0,
    retry: false,
  });
  const modules = BUSINESS_MODULES.map((module) => ({
    ...module,
    items: allowedItems(module.items, has, features),
  })).filter((module) => module.items.length > 0);
  const platform = allowedItems(PLATFORM_MODULE.items, has);
  const isAdmin =
    !!user?.roles.includes("admin") ||
    has("user:manage") ||
    has("organization:manage") ||
    has("samba:read");
  const filesModule = BUSINESS_MODULES.find(module => module.id === "files")!;
  const fileHome = moduleHome(filesModule, has, features);
  const managesFiles = fileHome === "/samba/overview";
  const adminWithoutIdentity = !files.data?.identity && (!!user?.roles.includes("admin") || has("samba:read"));
  const directories = files.data?.connected ? files.data.shares || [] : [];
  const filtered = directories.filter((name) =>
    name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const hour = today.getHours();
  const greeting = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const name = user?.name || user?.username || t("workbench.colleague");
  const services = modules.map((module) => ({
    id: module.id,
    label: t(module.labelKey),
    to: moduleHome(module, has, features),
    description: t("workbench.service." + module.id),
  }));
  if (has("ticket:create"))
    services.unshift({
      id: "new-ticket",
      label: t("nav.newTicket"),
      to: "/tickets/new",
      description: t("workbench.newTicketHint"),
    });

  return (
    <div
      className="mx-auto max-w-[1320px] space-y-7 pb-8"
      aria-label={t("workbench.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="font-medium text-gray-600 dark:text-gray-300">
          {t("workbench.title")}
        </p>
        <time dateTime={today.toISOString()} className="text-gray-500">
          {new Intl.DateTimeFormat(localeOf(i18n.language), {
            year: "numeric",
            month: "long",
            day: "numeric",
            weekday: "long",
          }).format(today)}
        </time>
      </div>

      <section className="relative isolate overflow-hidden rounded-3xl border border-brand-200/70 bg-gradient-to-br from-brand-50 via-brand-50 to-white p-6 sm:p-9 dark:border-brand-900 dark:from-brand-950 dark:via-brand-950 dark:to-gray-900">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-24 h-96 w-96 rounded-full border-[48px] border-brand-200/30 dark:border-brand-800/20"
        />
        <div className="relative flex flex-wrap items-center justify-between gap-8">
          <div className="max-w-xl">
            <p className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-brand-800 dark:text-brand-300">
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-brand-600"
              />
              GREENSTOR WORKSPACE
            </p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {t("workbench." + greeting, { name })}
            </h1>
            <p className="mt-3 text-sm leading-7 text-gray-600 dark:text-gray-300">
              {t("workbench.welcome")}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              {features.files && (
                <Link
                  to={fileHome}
                  className="inline-flex min-h-11 items-center gap-3 rounded-xl bg-brand-700 px-5 text-sm font-medium text-white transition hover:bg-brand-800"
                >
                  {t(managesFiles ? "workbench.manageFiles" : "workbench.openFiles")}
                  <Icon name="chevron" />
                </Link>
              )}
              {has("ticket:create") && (
                <Link
                  to="/tickets/new"
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-brand-200 bg-white/80 px-4 text-sm font-medium text-brand-900 hover:bg-white dark:border-brand-800 dark:bg-gray-900 dark:text-brand-200"
                >
                  <Icon name="plus" />
                  {t("nav.newTicket")}
                </Link>
              )}
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-4 rounded-2xl border border-white/70 bg-white/65 p-5 sm:min-w-64 dark:border-brand-800/60 dark:bg-gray-900/60">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-100 text-lg font-semibold text-brand-800 dark:bg-brand-900 dark:text-brand-200">
              {Array.from(name).slice(0, 2).join("").toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="max-w-52 truncate font-semibold">{name}</p>
              <p className="mt-1 text-xs text-gray-500">
                {t(
                  user?.passwordSource === "directory"
                    ? "workbench.companyAccount"
                    : "workbench.localAccount",
                )}
              </p>
              <Link
                to="/settings"
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-800 hover:underline dark:text-brand-300"
              >
                {t("nav.personalSettings")}
                <Icon name="chevron" className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-7">
          {features.files && (
            <section
              aria-labelledby="workbench-folders"
              className={surface + " p-5 sm:p-6"}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 id="workbench-folders" className="text-lg font-semibold">
                    {t("workbench.directories")}
                  </h2>
                  <p className="mt-1 text-sm text-gray-500">
                    {t("workbench.directoriesHint")}
                  </p>
                </div>
                <button
                  onClick={() => void files.refetch()}
                  disabled={files.isFetching}
                  aria-label={t("workbench.refreshDirectories")}
                  className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
                >
                  <Icon
                    name="refresh"
                    className={files.isFetching ? "animate-spin" : ""}
                  />
                </button>
              </div>
              {files.isPending ? (
                <div role="status" className="mt-5 grid gap-4 sm:grid-cols-2">
                  <span className="sr-only">{t("common.loading")}</span>
                  {[0, 1].map((n) => (
                    <div
                      key={n}
                      aria-hidden="true"
                      className="h-40 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800"
                    />
                  ))}
                </div>
              ) : files.isError || !files.data?.connected ? (
                <div className="mt-5 rounded-xl bg-gray-50 p-5 dark:bg-gray-950">
                  <p
                    role={files.isError ? "alert" : undefined}
                    className="text-sm text-gray-600 dark:text-gray-300"
                  >
                    {t(
                      files.isError
                        ? "workbench.filesUnavailable"
                        : files.data?.identity
                          ? "workbench.filesDisconnected"
                          : adminWithoutIdentity
                            ? "workbench.adminFilesUnlinkedHint"
                            : "workbench.filesUnlinked",
                    )}
                  </p>
                  <Link
                    to={adminWithoutIdentity ? (managesFiles ? fileHome : "/settings") : "/files"}
                    className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-800 dark:text-brand-300"
                  >
                    {t(adminWithoutIdentity ? (managesFiles ? "workbench.manageFiles" : "nav.personalSettings") : "workbench.openFiles")}
                    <Icon name="chevron" />
                  </Link>
                </div>
              ) : (
                <>
                  {directories.length > 4 && (
                    <label className="mt-5 flex items-center gap-2 rounded-xl border border-gray-200 px-3 dark:border-gray-700">
                      <Icon name="search" className="text-gray-400" />
                      <input
                        aria-label={t("workbench.searchDirectories")}
                        placeholder={t("workbench.searchDirectories")}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="min-h-11 w-full min-w-0 bg-transparent text-sm outline-none"
                      />
                    </label>
                  )}
                  <div className="mt-5 grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                    {filtered.map((directory) => (
                      <Link
                        key={directory}
                        to={fileHref(directory)}
                        aria-label={t("workbench.openDirectory", {
                          name: directory,
                        })}
                        className="group rounded-2xl border border-gray-100 bg-gray-50/70 p-5 transition hover:-translate-y-0.5 hover:border-brand-300 hover:bg-brand-50 hover:shadow-sm motion-reduce:transform-none dark:border-gray-800 dark:bg-gray-950/40 dark:hover:border-brand-700 dark:hover:bg-brand-950/40"
                      >
                        <div className="flex items-center justify-between">
                          <FileIcon
                            name={directory}
                            directory
                            shared
                            className="h-14 w-16"
                          />
                          <Icon
                            name="chevron"
                            className="text-gray-300 transition group-hover:translate-x-1 group-hover:text-brand-700 dark:text-gray-600"
                          />
                        </div>
                        <h3
                          className="mt-4 truncate font-semibold"
                          title={directory}
                        >
                          {directory}
                        </h3>
                        <p className="mt-1 text-xs text-gray-500">
                          {t("workbench.sharedDirectory")}
                        </p>
                      </Link>
                    ))}
                  </div>
                  {!filtered.length && (
                    <p
                      role="status"
                      className="py-8 text-center text-sm text-gray-500"
                    >
                      {t(
                        directories.length
                          ? "workbench.noSearchResults"
                          : "workbench.noDirectories",
                      )}
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          <section aria-labelledby="workbench-services">
            <div className="mb-4">
              <h2 id="workbench-services" className="text-lg font-semibold">
                {t("workbench.services")}
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                {t("workbench.servicesHint")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {services.map((service) => (
                <Link
                  key={service.id}
                  to={service.to}
                  className={
                    surface +
                    " group flex items-start gap-4 p-5 transition hover:border-brand-300 hover:shadow-sm dark:hover:border-brand-700"
                  }
                >
                  <span className="rounded-xl bg-brand-50 p-3 text-brand-800 dark:bg-brand-950 dark:text-brand-300">
                    <ServiceIcon name={service.id} className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold">{service.label}</h3>
                    <p className="mt-1 text-xs leading-5 text-gray-500">
                      {service.description}
                    </p>
                  </div>
                  <Icon
                    name="chevron"
                    className="mt-1 shrink-0 text-gray-400 group-hover:text-brand-700"
                  />
                </Link>
              ))}
            </div>
            {!services.length && (
              <p className={surface + " p-6 text-sm text-gray-500"}>
                {t("workbench.noServices")}
              </p>
            )}
          </section>
        </div>

        <aside className="space-y-5" aria-label={t("workbench.shortcuts")}>
          <section className={surface + " p-5"}>
            <h2 className="font-semibold">{t("workbench.shortcuts")}</h2>
            <Link
              to="/settings"
              className="mt-4 flex items-center gap-3 rounded-xl bg-gray-50 p-3 hover:bg-brand-50 dark:bg-gray-950 dark:hover:bg-brand-950"
            >
              <ServiceIcon name="account" className="h-5 w-5 text-gray-500" />
              <span className="flex-1 text-sm">
                {t("nav.personalSettings")}
              </span>
              <Icon name="chevron" className="text-gray-400" />
            </Link>
            <p className="mt-4 text-xs leading-6 text-gray-500">
              {t("workbench.accountHint")}
            </p>
          </section>
          {(platform.length > 0 ||
            (features.directory && has("samba:read"))) && (
            <section className={surface + " p-5"}>
              <h2 className="font-semibold">{t("workbench.administration")}</h2>
              <div className="mt-3 space-y-1">
                {platform.length > 0 && (
                  <Link
                    to={platform[0].to}
                    className="flex items-center gap-3 rounded-lg py-3 text-sm text-gray-600 hover:text-brand-700 dark:text-gray-300"
                  >
                    <ServiceIcon name="platform" className="h-5 w-5" />
                    {t("nav.platformManagement")}
                    <Icon name="chevron" className="ml-auto" />
                  </Link>
                )}
                {features.directory && has("samba:read") && (
                  <Link
                    to="/samba/overview"
                    className="flex items-center gap-3 rounded-lg py-3 text-sm text-gray-600 hover:text-brand-700 dark:text-gray-300"
                  >
                    <ServiceIcon name="files" className="h-5 w-5" />
                    {t("nav.fileAdministration")}
                    <Icon name="chevron" className="ml-auto" />
                  </Link>
                )}
              </div>
            </section>
          )}
          <div className="px-2 text-xs leading-6 text-gray-400">
            <p className="font-medium text-gray-500 dark:text-gray-400">
              GREENSTOR · {t("workbench.title")}
            </p>
            <p>{t("workbench.footer")}</p>
          </div>
        </aside>
      </div>
      {isAdmin && <CopOverview />}
    </div>
  );
}
