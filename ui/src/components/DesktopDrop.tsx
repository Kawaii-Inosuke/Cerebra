// Desktop: the window gets native drag-drop events with file paths. `.cerebra` files open the
// import preview; anything else is added to the collection under the pointer, the current one, or Inbox.
import { useEffect, useRef } from "react";
import { INBOX, useActions } from "../actions";
import { useApi } from "../context";
import { planDrop } from "../lib/drop";
import { useShare } from "../share";

export function DesktopDrop({ current }: { current: string | null }) {
  const api = useApi();
  const actions = useActions();
  const share = useShare();
  const ref = useRef({ actions, share, current });
  ref.current = { actions, share, current };

  useEffect(
    () =>
      api.onFileDrop((paths, at) => {
        const { actions, share, current } = ref.current;
        const plan = planDrop(paths, { at, current, fallback: null, inbox: INBOX, elementAt: (x, y) => document.elementFromPoint(x, y) });
        if (plan.shares[0]) share.openImport(plan.shares[0]);
        if (plan.uploads.length) void actions.uploadPaths(plan.uploads, plan.collection);
      }),
    [api],
  );
  return null;
}
