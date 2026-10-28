import { Link, useNavigate } from "@tanstack/react-router";
import type { ComponentProps } from "react";

/**
 * The item list and its detail pane share one URL per scope (`/vault`, `/vault/v/:id`, ...);
 * the selected item and the editor mode are search params (`?item=<id>&mode=edit`). Item ids are
 * random uuids, never content. These helpers change only the search of the current route.
 */
export interface WorkspaceSearch {
  item?: string;
  mode?: "edit" | "new";
}

export function validateWorkspaceSearch(search: Record<string, unknown>): WorkspaceSearch {
  const result: WorkspaceSearch = {};
  if (typeof search.item === "string" && search.item) result.item = search.item;
  if (search.mode === "edit" || search.mode === "new") result.mode = search.mode;
  return result;
}

type LinkProps = Omit<ComponentProps<typeof Link>, "to" | "search"> & {
  search: WorkspaceSearch;
};

export function WorkspaceLink({ search, ...props }: LinkProps) {
  return <Link to="." search={search as never} {...props} />;
}

export function useWorkspaceNavigate() {
  const navigate = useNavigate();
  return (search: WorkspaceSearch, options: { replace?: boolean } = {}) =>
    navigate({ to: ".", search: search as never, replace: options.replace ?? false });
}
