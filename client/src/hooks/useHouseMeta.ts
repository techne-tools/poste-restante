import { useEffect, useState } from "react";
import { house } from "../api";

/** Just enough of the house's words for the door to introduce itself. */
export interface DoorMeta {
  houseName?: string;
  pubName?: string;
  /** Whether the house offers a provider door. */
  oidcEnabled?: boolean;
}

/**
 * The community's names for the house and the pub, read at the door.
 *
 * GET /v1/house/meta is keyless by default (HOUSE_META_PUBLIC), so a
 * signed-out visitor can be greeted by the community's own names; a keyed
 * house answers 401 and the door falls back to the founding vocabulary.
 * A closed read is silence, never an error.
 */
export function useHouseMeta(): DoorMeta {
  const [meta, setMeta] = useState<DoorMeta>({});
  useEffect(() => {
    let cancelled = false;
    house
      .houseMeta()
      .then((m) => {
        if (!cancelled) {
          setMeta({ houseName: m.houseName, pubName: m.pubName, oidcEnabled: m.oidcEnabled });
        }
      })
      .catch(() => {
        // The door keeps its founding words — a keyed house stays quiet.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return meta;
}
