// The seat map (DSH-09 #251, DSH-11 #308): the whole org as one canvas of tables sized to
// their teams, with zoom, pan, a minimap and find. The drawing is a 2D canvas showing only
// what is on screen; on top of it sits a list of the tables (one tab stop each) and, for the
// tables on screen when zoomed in, a list of their chairs as links, so keyboard and screen
// reader users get the same map. Green is Active, red anything else; the exact status is
// always text too (accessible name and tooltip).
import { Link } from "@tanstack/react-router";
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { type PresenceStatus, StatusChip } from "../../components/StatusChip";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { initials } from "../../lib/nav";
import { formatTime } from "../../lib/time";
import { since, type TeamRow } from "./grid";
import { drawMinimap, drawSeatMap, type Palette, readPalette } from "./seatCanvas";
import {
  CHAIR_SIZE,
  findSeats,
  groupTables,
  inactiveLabels,
  layoutKey,
  layoutSeats,
  nextSeat,
  type PlacedTable,
  type SeatLayout,
  type SeatMatch,
  seatGroups,
  seatName,
  seatPoint,
  seatTone,
  tableLabel,
  tablesBox,
} from "./seats";
import {
  CHAIRS_K,
  centerOf,
  centerOn,
  clamp,
  clampView,
  contains,
  type Detail,
  detailFor,
  ease,
  fitRect,
  fitZoom,
  intersects,
  type Limits,
  parseSavedView,
  type Rect,
  type Size,
  toCanvas,
  toScreen,
  tween,
  type View,
  visibleRect,
  wheelPixels,
  wheelZoom,
  ZOOM_STEP,
  zoomAt,
  zoomLimits,
} from "./viewport";

/** Existing status tokens: Active's green and Tamper's red (no new colours). */
const toneClass = {
  active: "text-[var(--sactive)]",
  inactive: "text-[var(--stamper)]",
} as const;

/** Orgs up to this size keep every chair in the accessible list; bigger ones only those on screen. */
const ALL_CHAIRS_UP_TO = 300;
const MINIMAP = { width: 200, height: 130 };
const FONT = '"Geist Variable", ui-sans-serif, system-ui, sans-serif';

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function readSaved(key: string) {
  try {
    return parseSavedView(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered this time.
  }
}

interface Tip {
  table: number;
  seat: number;
}

export function SeatMap({
  rows,
  teams,
  teamId,
  status,
  search,
  findStep,
  storageKey,
  zone,
  now,
  projectName,
}: {
  /** Everyone the viewer can see: the map always shows the whole org (DSH-11). */
  rows: TeamRow[];
  teams: { id: string; name: string }[];
  /** A picked team: zoomed to and ringed, not filtered (DSH-11). */
  teamId: string;
  /** A picked status: everyone else is drawn faint, so nobody moves. */
  status: PresenceStatus | "all";
  /** Find a team or person: zooms to the match and rings every match. */
  search: string;
  /** Goes up each time the viewer asks for the next match. */
  findStep: number;
  /** Where this viewer's zoom and position are remembered. */
  storageKey: string;
  zone: string;
  now: Date;
  projectName: Map<string, string>;
}) {
  const id = useId();
  const regionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const miniViewRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // The layout depends only on teams and who is in which (layoutKey): live status updates
  // reuse it, so nobody moves and nothing is laid out again (DSH-11).
  const key = useMemo(() => layoutKey(rows, teams), [rows, teams]);
  const cache = useRef<{ key: string; layout: SeatLayout; version: number } | null>(null);
  if (cache.current?.key !== key) {
    cache.current = {
      key,
      layout: layoutSeats(seatGroups(rows, teams)),
      version: (cache.current?.version ?? 0) + 1,
    };
  }
  const { layout, version } = cache.current;
  const content = useMemo<Rect>(
    () => ({ x: 0, y: 0, w: Math.max(layout.width, 1), h: Math.max(layout.height, 1) }),
    [layout],
  );
  const byId = useMemo(() => new Map(rows.map((r) => [r.user_id ?? "", r])), [rows]);
  const counts = useMemo(
    () =>
      layout.tables.map((t) => ({
        total: t.people.length,
        active: t.people.filter((p) => seatTone(byId.get(p)?.status) === "active").length,
      })),
    [layout, byId],
  );

  // What's found or picked, ringed on the map.
  const [query, setQuery] = useState(search);
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(search), 250);
    return () => window.clearTimeout(t);
  }, [search]);
  const matches = useMemo(
    () => findSeats(layout, (uid) => byId.get(uid)?.full_name ?? "", query),
    [layout, byId, query],
  );
  const teamTables = useMemo(() => (teamId ? groupTables(layout, teamId) : []), [layout, teamId]);
  const highlight = useMemo(() => {
    const tables = new Set<number>(teamTables);
    const people = new Set<string>();
    for (const m of matches) {
      if (m.kind === "team") for (const i of m.tables) tables.add(i);
      else people.add(m.userId);
    }
    return { tables, people };
  }, [matches, teamTables]);

  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const dprRef = useRef(1);
  const limitsRef = useRef<Limits>({ min: 0.1, max: 2 });
  const paletteRef = useRef<Palette | null>(null);
  const frameRef = useRef(0);
  const animRef = useRef(0);
  /** Where a running animation is heading, so quick presses of + or − add up. */
  const animTarget = useRef<View | null>(null);
  const saveRef = useRef(0);
  const readyRef = useRef(false);
  const pendingFocus = useRef<{ table: number; seat: number } | null>(null);
  const focusTable = useRef<number | null>(null);

  const [detail, setDetail] = useState<Detail>("chairs");
  const [zoom, setZoom] = useState(100);
  const [shown, setShown] = useState<string>("");
  const [miniVisible, setMiniVisible] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const [announce, setAnnounce] = useState("");
  const [grabbing, setGrabbing] = useState(false);
  const allChairs = rows.length <= ALL_CHAIRS_UP_TO;

  // Everything the frame reads, current without re-subscribing anything.
  const live = useRef({ layout, byId, counts, highlight, status, allChairs, tip, content });
  live.current = { layout, byId, counts, highlight, status, allChairs, tip, content };

  const positionTip = useCallback(() => {
    const el = tipRef.current;
    const t = live.current.tip;
    const table = t ? live.current.layout.tables[t.table] : undefined;
    if (!el || !t || !table) return;
    const v = viewRef.current;
    const p = seatPoint(table, t.seat);
    const s = toScreen(v, p.x, p.y);
    const size = sizeRef.current;
    const r = (CHAIR_SIZE / 2) * v.k + 6;
    const below = s.y < size.height / 2;
    el.style.left = `${clamp(s.x - el.offsetWidth / 2, 8, Math.max(8, size.width - el.offsetWidth - 8))}px`;
    el.style.top = below ? `${s.y + r}px` : `${s.y - r - el.offsetHeight}px`;
  }, []);

  const frame = useCallback(() => {
    frameRef.current = 0;
    const canvas = canvasRef.current;
    const size = sizeRef.current;
    const palette = paletteRef.current;
    if (!canvas || !palette || size.width === 0) return;
    const v = viewRef.current;
    const d = detailFor(v.k);
    const { layout, byId, counts, highlight, status, allChairs } = live.current;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      drawSeatMap(ctx, {
        view: v,
        size,
        dpr: dprRef.current,
        detail: d,
        layout,
        palette,
        font: FONT,
        toneOf: (uid) => seatTone(byId.get(uid)?.status),
        initialsOf: (uid) => initials(byId.get(uid)?.full_name ?? ""),
        counts: (i) => counts[i] ?? { total: 0, active: 0 },
        highlightTables: highlight.tables,
        highlightPeople: highlight.people,
        faded: (uid) => status !== "all" && byId.get(uid)?.status !== status,
      });
    }
    const layer = layerRef.current;
    if (layer) {
      layer.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
      layer.style.setProperty("--k", String(v.k));
    }
    const seen = visibleRect(v, size);
    const mini = miniViewRef.current;
    if (mini) {
      const { content } = live.current;
      const scale = Math.min(MINIMAP.width / content.w, MINIMAP.height / content.h);
      mini.style.left = `${seen.x * scale}px`;
      mini.style.top = `${seen.y * scale}px`;
      mini.style.width = `${seen.w * scale}px`;
      mini.style.height = `${seen.h * scale}px`;
    }
    positionTip();

    // Which tables list their chairs: all of them in a small org; otherwise the ones on
    // screen when zoomed in, plus the one with the focus or about to get it.
    const keep = new Set<number>();
    if (allChairs) {
      for (let i = 0; i < layout.tables.length; i++) keep.add(i);
    } else if (d === "chairs") {
      layout.tables.forEach((t, i) => {
        if (intersects(seen, { x: t.x, y: t.y, w: t.w, h: t.h })) keep.add(i);
      });
    }
    if (focusTable.current !== null) keep.add(focusTable.current);
    if (pendingFocus.current) keep.add(pendingFocus.current.table);
    const next = [...keep].sort((a, b) => a - b).join(",");
    setShown((prev) => (prev === next ? prev : next));
    setDetail(d);
    setZoom(Math.round(v.k * 100));
    setMiniVisible(layout.tables.length > 1 && !contains(seen, live.current.content));

    // Remembered per viewer, once the view settles.
    window.clearTimeout(saveRef.current);
    saveRef.current = window.setTimeout(() => {
      const c = centerOf(viewRef.current, sizeRef.current);
      const k = viewRef.current.k;
      regionRef.current?.setAttribute("data-center", `${Math.round(c.x)},${Math.round(c.y)}`);
      if (readyRef.current) save(storageKey, JSON.stringify({ cx: c.x, cy: c.y, k }));
    }, 300);
  }, [positionTip, storageKey]);

  const draw = useCallback(() => {
    if (!frameRef.current) frameRef.current = requestAnimationFrame(frame);
  }, [frame]);

  const setView = useCallback(
    (v: View) => {
      const size = sizeRef.current;
      const k = clamp(v.k, limitsRef.current.min, limitsRef.current.max);
      let scaled = v;
      if (k !== v.k) {
        const c = centerOf(v, size);
        scaled = centerOn(c.x, c.y, k, size);
      }
      viewRef.current = clampView(scaled, live.current.content, size, 80);
      draw();
    },
    [draw],
  );

  const stopAnimation = useCallback(() => {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = 0;
  }, []);

  const animateTo = useCallback(
    (target: View) => {
      stopAnimation();
      const size = sizeRef.current;
      if (reducedMotion() || size.width === 0) {
        setView(target);
        return;
      }
      const from = viewRef.current;
      const start = performance.now();
      animTarget.current = target;
      const step = (t: number) => {
        const p = Math.min(1, (t - start) / 240);
        setView(tween(from, target, ease(p), size));
        animRef.current = p < 1 ? requestAnimationFrame(step) : 0;
        if (!animRef.current) animTarget.current = null;
      };
      animRef.current = requestAnimationFrame(step);
    },
    [setView, stopAnimation],
  );

  /** The view showing `box`, no closer than `most`. */
  const viewOf = useCallback((box: Rect, most: number): View => {
    const size = sizeRef.current;
    const { min, max } = limitsRef.current;
    return fitRect(box, size, 32, { min, max: Math.min(max, most) });
  }, []);

  const fitAll = useCallback(
    (animate = true) => {
      const v = viewOf(live.current.content, 1);
      if (animate) animateTo(v);
      else setView(v);
    },
    [animateTo, setView, viewOf],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const size = sizeRef.current;
      const v = (animRef.current && animTarget.current) || viewRef.current;
      stopAnimation();
      const target = zoomAt(v, factor, size.width / 2, size.height / 2, limitsRef.current);
      animateTo(target);
    },
    [animateTo, stopAnimation],
  );

  const zoomTo100 = useCallback(() => {
    const c = centerOf((animRef.current && animTarget.current) || viewRef.current, sizeRef.current);
    animateTo(centerOn(c.x, c.y, 1, sizeRef.current));
  }, [animateTo]);

  /** Zooms to a table close enough to see its chairs. */
  const zoomToTable = useCallback(
    (i: number) => {
      const t = live.current.layout.tables[i];
      if (!t) return;
      const size = sizeRef.current;
      const k = clamp(
        Math.max(CHAIRS_K, Math.min(1, fitZoom(t, size, 32))),
        CHAIRS_K,
        limitsRef.current.max,
      );
      animateTo(centerOn(t.x + t.w / 2, t.y + t.h / 2, k, size));
    },
    [animateTo],
  );

  /** Brings a table (or one of its chairs) on screen when the keyboard moves to it. */
  const reveal = useCallback(
    (i: number, seat: number | null) => {
      focusTable.current = i;
      const t = live.current.layout.tables[i];
      if (!t) return;
      // Judged by where a running zoom is heading, so it isn't cut short.
      const v = (animRef.current && animTarget.current) || viewRef.current;
      const size = sizeRef.current;
      const seen = visibleRect(v, size);
      const target: Rect =
        seat === null
          ? { x: t.x, y: t.y, w: t.w, h: t.h }
          : (() => {
              const p = seatPoint(t, seat);
              return {
                x: p.x - CHAIR_SIZE,
                y: p.y - CHAIR_SIZE,
                w: 2 * CHAIR_SIZE,
                h: 2 * CHAIR_SIZE,
              };
            })();
      if (contains(seen, target)) {
        draw();
        return;
      }
      const c = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
      animateTo(centerOn(c.x, c.y, v.k, size));
    },
    [animateTo, draw],
  );

  const enterTable = useCallback(
    (i: number, seat: number) => {
      pendingFocus.current = { table: i, seat };
      zoomToTable(i);
      draw();
    },
    [draw, zoomToTable],
  );

  const onFocusDone = useCallback(() => {
    pendingFocus.current = null;
  }, []);

  const onLeaveTable = useCallback(
    (i: number) => {
      if (focusTable.current === i) focusTable.current = null;
      draw();
    },
    [draw],
  );

  // Size, colours and the first view (decided once, when the map first has a size).
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialView runs once, on first size
  useEffect(() => {
    const region = regionRef.current;
    const canvas = canvasRef.current;
    if (!region || !canvas) return;
    paletteRef.current = readPalette(region);
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onScheme = () => {
      paletteRef.current = readPalette(region);
      draw();
    };
    dark?.addEventListener("change", onScheme);
    const ro = new ResizeObserver(() => {
      const rect = region.getBoundingClientRect();
      const before = sizeRef.current;
      const size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      if (size.width === 0 || size.height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      canvas.width = Math.round(size.width * dpr);
      canvas.height = Math.round(size.height * dpr);
      sizeRef.current = size;
      limitsRef.current = zoomLimits(live.current.content, size);
      if (!readyRef.current) {
        readyRef.current = true;
        initialView();
      } else {
        // Keep the same point in the middle.
        const c = centerOf(viewRef.current, before);
        setView(centerOn(c.x, c.y, viewRef.current.k, size));
      }
      draw();
    });
    ro.observe(region);
    return () => {
      ro.disconnect();
      dark?.removeEventListener("change", onScheme);
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      stopAnimation();
      window.clearTimeout(saveRef.current);
    };
  }, [draw, setView, stopAnimation]);

  /** A picked team (or a link to one) wins, then where this viewer left off, then everything. */
  function initialView() {
    const box = teamId ? tablesBox(layout, groupTables(layout, teamId)) : null;
    const saved = readSaved(storageKey);
    if (box) setView(viewOf(box, 1.25));
    else if (saved) setView(centerOn(saved.cx, saved.cy, saved.k, sizeRef.current));
    else fitAll(false);
    if (teamId) setAnnounce(teamAnnouncement(teamId));
  }

  function teamAnnouncement(group: string): string {
    const name = teams.find((t) => t.id === group)?.name ?? "This team";
    const tables = groupTables(layout, group);
    const people = tables.reduce((n, i) => n + (counts[i]?.total ?? 0), 0);
    const active = tables.reduce((n, i) => n + (counts[i]?.active ?? 0), 0);
    return people
      ? `Showing ${name}: ${people} ${people === 1 ? "person" : "people"}, ${active} active.`
      : `No one you can see is in ${name}.`;
  }

  // New layout (people joined or left): new zoom limits, and redraw.
  useEffect(() => {
    if (sizeRef.current.width) limitsRef.current = zoomLimits(content, sizeRef.current);
    draw();
  }, [content, draw]);

  // Live updates and highlights only redraw.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are what the frame reads
  useEffect(() => {
    draw();
  }, [draw, byId, highlight, status, tip]);

  // Picking a team zooms to it (the first view already did for a link to one).
  const lastTeam = useRef(teamId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of team zooms
  useEffect(() => {
    if (lastTeam.current === teamId) return;
    lastTeam.current = teamId;
    if (!teamId || !readyRef.current) return;
    const box = tablesBox(layout, groupTables(layout, teamId));
    if (box) animateTo(viewOf(box, 1.25));
    setAnnounce(teamAnnouncement(teamId));
  }, [teamId]);

  // Finding zooms to the match (the next one each time the viewer asks).
  const matchIndex = useRef(0);
  const lastFind = useRef({ query: "", step: findStep });
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new query or step moves the view
  useEffect(() => {
    const prev = lastFind.current;
    lastFind.current = { query, step: findStep };
    if (!query.trim()) {
      if (prev.query) setAnnounce("");
      return;
    }
    if (matches.length === 0) {
      setAnnounce(`No team or person matches “${query.trim()}”.`);
      return;
    }
    const n = query === prev.query ? findStep - prev.step : 0;
    const at = prev.query === query ? (matchIndex.current + n) % matches.length : 0;
    matchIndex.current = at;
    const m = matches[at] as SeatMatch;
    if (readyRef.current) goTo(m);
    const what = m.kind === "team" ? `${m.name} (team)` : m.name;
    setAnnounce(
      matches.length === 1
        ? `Showing ${what}.`
        : `Showing ${what}, ${at + 1} of ${matches.length} matches. Press Enter in the search box for the next.`,
    );
  }, [query, findStep]);

  function goTo(m: SeatMatch) {
    if (m.kind === "team") {
      const box = tablesBox(layout, m.tables);
      if (box) animateTo(viewOf(box, 1.25));
      return;
    }
    const t = layout.tables[m.table];
    if (!t) return;
    const p = seatPoint(t, m.seat);
    animateTo(centerOn(p.x, p.y, Math.max(1, viewRef.current.k), sizeRef.current));
  }

  // The minimap's tables only change with the layout, highlights or colours.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw on these
  useEffect(() => {
    const mini = miniRef.current;
    const palette = paletteRef.current;
    if (!mini || !palette) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(MINIMAP.width / content.w, MINIMAP.height / content.h);
    mini.width = Math.round(content.w * scale * dpr);
    mini.height = Math.round(content.h * scale * dpr);
    mini.style.width = `${content.w * scale}px`;
    mini.style.height = `${content.h * scale}px`;
    const ctx = mini.getContext("2d");
    if (ctx) drawMinimap(ctx, layout, scale, dpr, palette, highlight.tables);
    draw();
  }, [layout, highlight, content]);

  // Wheel: scroll pans, Ctrl/Cmd + scroll and trackpad pinches zoom. Safari reports pinches
  // as gesture events instead.
  useEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopAnimation();
      const rect = region.getBoundingClientRect();
      const dx = wheelPixels(e.deltaX, e.deltaMode);
      const dy = wheelPixels(e.deltaY, e.deltaMode);
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        setView(
          zoomAt(v, wheelZoom(dy), e.clientX - rect.left, e.clientY - rect.top, limitsRef.current),
        );
      } else if (e.shiftKey && dx === 0) {
        setView({ ...v, x: v.x - dy });
      } else {
        setView({ ...v, x: v.x - dx, y: v.y - dy });
      }
    };
    let gestureScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const rect = region.getBoundingClientRect();
      setView(
        zoomAt(
          viewRef.current,
          g.scale / gestureScale,
          g.clientX - rect.left,
          g.clientY - rect.top,
          limitsRef.current,
        ),
      );
      gestureScale = g.scale;
    };
    region.addEventListener("wheel", onWheel, { passive: false });
    region.addEventListener("gesturestart", onGestureStart);
    region.addEventListener("gesturechange", onGestureChange);
    return () => {
      region.removeEventListener("wheel", onWheel);
      region.removeEventListener("gesturestart", onGestureStart);
      region.removeEventListener("gesturechange", onGestureChange);
    };
  }, [setView, stopAnimation]);

  // Space + drag pans, like design tools, while the pointer is over the map.
  const hovering = useRef(false);
  const spaceHeld = useRef(false);
  useEffect(() => {
    const editable = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t.tagName));
    const down = (e: globalThis.KeyboardEvent) => {
      if (e.key !== " " || editable(e.target)) return;
      if (!hovering.current && !regionRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      if (!spaceHeld.current) {
        spaceHeld.current = true;
        setGrabbing(true);
      }
    };
    const up = (e: globalThis.KeyboardEvent) => {
      if (e.key !== " ") return;
      spaceHeld.current = false;
      setGrabbing(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Dragging pans (from anywhere, chairs too, once it moves); two fingers pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pinch = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);
  const suppressClick = useRef(false);

  const local = (e: PointerEvent) => {
    const rect = regionRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return null;
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stopAnimation();
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 2) {
      pinch.current = pinchState();
      drag.current = null;
      return;
    }
    const p = local(e);
    drag.current = { x: p.x, y: p.y, moved: spaceHeld.current };
    if (spaceHeld.current) {
      e.preventDefault();
      regionRef.current?.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pinch.current && pointers.current.size >= 2) {
      const now = pinchState();
      if (!now) return;
      const v = viewRef.current;
      const zoomed = zoomAt(
        v,
        now.dist / Math.max(pinch.current.dist, 1),
        now.mid.x,
        now.mid.y,
        limitsRef.current,
      );
      setView({
        ...zoomed,
        x: zoomed.x + now.mid.x - pinch.current.mid.x,
        y: zoomed.y + now.mid.y - pinch.current.mid.y,
      });
      pinch.current = now;
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) > 4) {
      d.moved = true;
      setGrabbing(true);
      regionRef.current?.setPointerCapture(e.pointerId);
    }
    if (d.moved) {
      const v = viewRef.current;
      setView({ ...v, x: v.x + p.x - d.x, y: v.y + p.y - d.y });
      d.x = p.x;
      d.y = p.y;
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    setGrabbing(spaceHeld.current);
    if (!d) return;
    if (d.moved) {
      suppressClick.current = true;
      return;
    }
    // A click on a table when zoomed out zooms to it.
    if (detailFor(viewRef.current.k) !== "chairs" && e.type === "pointerup") {
      const p = toCanvas(viewRef.current, d.x, d.y);
      const i = live.current.layout.tables.findIndex(
        (t) => p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h,
      );
      if (i >= 0) zoomToTable(i);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const size = sizeRef.current;
    if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / ZOOM_STEP);
    else if (e.key === "0") zoomTo100();
    else if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) fitAll();
    else if (e.target === e.currentTarget && e.key.startsWith("Arrow")) {
      const step = e.shiftKey ? size.width / 2 : 60;
      const v = viewRef.current;
      const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
      const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
      stopAnimation();
      setView({ ...v, x: v.x + dx, y: v.y + dy });
    } else return;
    e.preventDefault();
  };

  const onMiniPointer = (e: PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (e.type === "pointerdown") e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = Math.min(MINIMAP.width / content.w, MINIMAP.height / content.h);
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    stopAnimation();
    setView(centerOn(x, y, viewRef.current.k, sizeRef.current));
  };

  const shownSet = useMemo(() => new Set(shown ? shown.split(",").map(Number) : []), [shown]);
  const onTip = useCallback((t: Tip | null) => setTip(t), []);
  const tipRow = tip ? byId.get(layout.tables[tip.table]?.people[tip.seat] ?? "") : undefined;
  const tipId = `${id}-tip`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: place the tooltip once it has its size
  useEffect(() => {
    positionTip();
  }, [tip, positionTip]);

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-ink2">
        <span className="flex items-center gap-2">
          <span aria-hidden className="h-3 w-3 rounded-full bg-[var(--sactive)]" />
          Active
        </span>
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-3 w-3 rounded-full border-2 border-dashed border-[var(--stamper)]"
          />
          Not active: {inactiveLabels().join(", ")}
        </span>
        <fieldset className="m-0 flex items-center gap-1.5 border-0 p-0 lg:ml-auto">
          <legend className="sr-only">Zoom</legend>
          <Button
            variant="secondary"
            className="h-9 w-9 px-0"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            <span aria-hidden>−</span>
          </Button>
          <output
            className="w-14 text-center font-mono text-[12.5px] text-ink2"
            aria-label="Zoom level"
            aria-live="off"
          >
            {zoom}%
          </output>
          <Button
            variant="secondary"
            className="h-9 w-9 px-0"
            aria-label="Zoom in"
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <span aria-hidden>+</span>
          </Button>
          <Button variant="secondary" className="h-9 px-3" onClick={zoomTo100}>
            Zoom to 100%
          </Button>
          <Button variant="secondary" className="h-9 px-3" onClick={() => fitAll()}>
            Fit all
          </Button>
        </fieldset>
      </div>

      <section
        ref={regionRef}
        aria-label="Seat map"
        aria-describedby={`${id}-help`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the map takes arrow keys to pan and + / − to zoom
        tabIndex={0}
        data-detail={detail}
        data-zoom={zoom}
        data-layout-version={version}
        className={cn(
          "relative h-[min(70vh,720px)] min-h-[360px] touch-none overflow-hidden rounded-lg border border-line bg-bg select-none",
          grabbing ? "cursor-grabbing" : "cursor-grab",
        )}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerEnter={() => {
          hovering.current = true;
        }}
        onPointerLeave={() => {
          hovering.current = false;
        }}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onDragStart={(e) => e.preventDefault()}
        onScroll={(e) => {
          // Focusing a chair must not scroll the clipped layer; the view moves instead.
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
      >
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
        <div ref={layerRef} className="seat-layer absolute top-0 left-0 origin-top-left">
          <ul aria-label="Tables" className="m-0 list-none p-0">
            {layout.tables.map((t, i) => {
              const chairs = shownSet.has(i);
              return (
                <TableItem
                  key={t.key}
                  table={t}
                  index={i}
                  people={chairs ? t.people.map((p) => byId.get(p)) : undefined}
                  total={counts[i]?.total ?? 0}
                  active={counts[i]?.active ?? 0}
                  clickable={detail === "chairs"}
                  zone={zone}
                  focusSeat={
                    chairs && pendingFocus.current?.table === i ? pendingFocus.current.seat : null
                  }
                  tipSeat={tip?.table === i ? tip.seat : null}
                  tipId={tipId}
                  onEnter={enterTable}
                  onReveal={reveal}
                  onLeave={onLeaveTable}
                  onTip={onTip}
                  onFocusDone={onFocusDone}
                />
              );
            })}
          </ul>
        </div>

        {tipRow && (
          <div
            ref={tipRef}
            id={tipId}
            role="tooltip"
            className="pointer-events-none absolute z-10 w-max max-w-[260px] rounded-lg border border-line bg-panel px-3 py-2.5 text-[12.5px] shadow-md"
          >
            <div className="font-medium">{tipRow.full_name}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusChip
                status={(tipRow.status ?? "off_shift") as PresenceStatus}
                reason={tipRow.tamper_reason}
              />
              {tipRow.since && (
                <span className="text-ink3">
                  since {formatTime(tipRow.since, zone, zone)} · {since(tipRow.since, now)}
                </span>
              )}
            </div>
            <div className="mt-1.5 text-ink2">
              Project: {(tipRow.project_id && projectName.get(tipRow.project_id)) || "none"}
            </div>
          </div>
        )}

        <div
          className={cn(
            "absolute right-3 bottom-3 overflow-hidden rounded-md border border-line bg-panel shadow-sm",
            !miniVisible && "hidden",
          )}
          aria-hidden
        >
          <canvas
            ref={miniRef}
            className="block cursor-pointer"
            onPointerDown={onMiniPointer}
            onPointerMove={onMiniPointer}
          />
          <div
            ref={miniViewRef}
            className="pointer-events-none absolute rounded-[2px] border-2 border-acc"
          />
        </div>
      </section>

      <div className="flex flex-wrap items-start gap-x-5 gap-y-1 text-xs text-ink3">
        <p id={`${id}-help`} className="m-0">
          Drag or scroll to move; Ctrl or ⌘ + scroll, pinch, or + and − to zoom; 0 for 100%, Shift +
          1 to fit all. Tab moves between tables, arrow keys round a table, and Enter opens a
          person's day.
        </p>
        <p role="status" className="m-0 font-medium text-ink2 lg:ml-auto">
          {announce}
        </p>
      </div>
    </div>
  );
}

const TableItem = memo(function TableItem({
  table,
  index,
  people,
  total,
  active,
  clickable,
  zone,
  focusSeat,
  tipSeat,
  tipId,
  onEnter,
  onReveal,
  onLeave,
  onTip,
  onFocusDone,
}: {
  table: PlacedTable;
  index: number;
  /** The people at this table when its chairs are listed; otherwise the table is one stop. */
  people: (TeamRow | undefined)[] | undefined;
  total: number;
  active: number;
  /** Chairs take the pointer only when zoomed in enough to see them. */
  clickable: boolean;
  zone: string;
  focusSeat: number | null;
  tipSeat: number | null;
  tipId: string;
  onEnter: (table: number, seat: number) => void;
  onReveal: (table: number, seat: number | null) => void;
  onLeave: (table: number) => void;
  onTip: (tip: Tip | null) => void;
  onFocusDone: () => void;
}) {
  const id = useId();
  const [stop, setStop] = useState(0);
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const buttonFocused = useRef(false);
  const label = tableLabel(table);
  const summary = `${total} ${total === 1 ? "person" : "people"}, ${active} active`;
  // The roving tab stop stays on a seat that still exists when people leave.
  const at = Math.min(stop, table.people.length - 1);

  // The keyboard asked to go in (or the table's stop was replaced by its chairs).
  useEffect(() => {
    if (!people) return;
    if (focusSeat !== null) {
      const seat = Math.min(focusSeat, table.people.length - 1);
      setStop(seat);
      refs.current[seat]?.focus({ preventScroll: true });
      onFocusDone();
    } else if (buttonFocused.current) {
      refs.current[at]?.focus({ preventScroll: true });
    }
    buttonFocused.current = false;
  }, [people, focusSeat, table.people.length, at, onFocusDone]);

  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "Escape") {
      onTip(null);
      return;
    }
    const next = nextSeat(e.key, i, table.people.length);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    refs.current[next]?.focus({ preventScroll: true });
  };

  const isKeyboard = (el: Element) => {
    try {
      return el.matches(":focus-visible");
    } catch {
      return true;
    }
  };

  return (
    <li
      className="absolute"
      style={{ left: table.x, top: table.y, width: table.w, height: table.h }}
      data-table={table.key}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave(index);
      }}
    >
      <h2 id={`${id}-name`} className="sr-only">
        {label}
      </h2>
      {people ? (
        <ul aria-labelledby={`${id}-name`} className="m-0 list-none p-0">
          {people.map((r, i) => {
            const s = table.seats[i];
            if (!r || !s) return null;
            return (
              <li
                key={r.user_id}
                className="absolute"
                style={{
                  left: s.x - CHAIR_SIZE / 2,
                  top: s.y - CHAIR_SIZE / 2,
                  width: CHAIR_SIZE,
                  height: CHAIR_SIZE,
                }}
                onMouseEnter={() => clickable && onTip({ table: index, seat: i })}
                onMouseLeave={() => onTip(null)}
              >
                <Link
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  to="/team/$userId"
                  params={{ userId: r.user_id ?? "" }}
                  draggable={false}
                  tabIndex={i === at ? 0 : -1}
                  aria-label={seatName(r, zone)}
                  aria-describedby={tipSeat === i ? tipId : undefined}
                  className={cn(
                    "absolute inset-0 block rounded-full",
                    toneClass[seatTone(r.status)],
                    clickable ? "cursor-pointer" : "pointer-events-none",
                  )}
                  onFocus={(e) => {
                    setStop(i);
                    onTip({ table: index, seat: i });
                    if (isKeyboard(e.currentTarget)) onReveal(index, i);
                  }}
                  onBlur={() => onTip(null)}
                  onKeyDown={(e) => onKey(e, i)}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <button
          type="button"
          className="pointer-events-none absolute inset-0 rounded-[48px] bg-transparent"
          aria-label={`${label}: ${summary}. Press Enter to see the chairs.`}
          onFocus={(e) => {
            buttonFocused.current = true;
            if (isKeyboard(e.currentTarget)) onReveal(index, null);
          }}
          onBlur={() => {
            buttonFocused.current = false;
          }}
          onClick={() => onEnter(index, 0)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "Home") {
              e.preventDefault();
              e.stopPropagation();
              onEnter(index, 0);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "End") {
              e.preventDefault();
              e.stopPropagation();
              onEnter(index, table.people.length - 1);
            }
          }}
        />
      )}
    </li>
  );
});
