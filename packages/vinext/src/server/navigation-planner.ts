import { matchRoutePattern } from "../routing/route-pattern.js";
import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import type { RouteManifest, RouteManifestRoute } from "../routing/app-route-graph.js";
import { compareAppElementsSlotIds, type AppElementsSlotBinding } from "./app-elements.js";
import {
  NavigationTraceReasonCodes,
  createNavigationLifecycleTraceFields,
  createNavigationTrace,
  type NavigationTrace,
  type NavigationTraceFields,
  type NavigationTraceReasonCode,
} from "./navigation-trace.js";

export type OperationLane =
  | "hmr"
  | "navigation"
  | "prefetch"
  | "refresh"
  | "server-action"
  | "traverse";

export type OperationToken = {
  operationId: number;
  lane: OperationLane;
  baseVisibleCommitVersion: number;
  graphVersion: string | null;
  deploymentVersion: string | null;
  targetSnapshotFingerprint: string;
  cacheVariantFingerprint?: string;
};

export type RouteSnapshotV0 = {
  interception: InterceptionSnapshotV0 | null;
  interceptionContext: string | null;
  routeId: string;
  // Ordered ancestor-first, with the root layout at index 0. Same-layout
  // persistence uses prefix comparison, so callers must preserve this order.
  layoutIds: readonly string[];
  mountedParallelSlots: readonly MountedParallelSlotSnapshotV0[];
  rootBoundaryId: string | null;
  displayUrl: string;
  matchedUrl: string;
  slotBindings: readonly ParallelSlotBindingSnapshotV0[];
};

export type InterceptionSnapshotV0 = {
  sourceMatchedUrl: string;
  sourceRouteId: string;
  slotId: string;
  targetMatchedUrl: string;
  targetRouteId: string;
};

export type MountedParallelSlotSnapshotV0 = {
  slotId: string;
  ownerLayoutId: string | null;
};

// Planner snapshots consume the same canonical slot-binding facts decoded from
// AppElements metadata. Keep the alias explicit so route-state and transport
// readers cannot drift into structurally identical but semantically separate
// shapes.
export type ParallelSlotBindingSnapshotV0 = AppElementsSlotBinding;

export type NavigationPlannerStateV0 = {
  // V0 keeps a single state shape so intent events and result events can move
  // through one planner surface. flightResponseArrived uses event.token; later
  // #726 slices can split this by event kind once more result paths are routed
  // through the planner.
  nextOperationToken: OperationToken;
  // Callers that have lifecycle authority should pass the complete trace
  // context. When absent, the planner emits the stable root-boundary facts it
  // can derive from the event and visible snapshot.
  traceFields?: NavigationTraceFields;
  visibleCommitVersion: number;
  visibleSnapshot: RouteSnapshotV0;
};

export type RefreshScope = "visible";
export type TraverseDirection = "back" | "forward" | "unknown";

export type NavigationEvent =
  | { kind: "navigate"; href: string; mode: "push" | "replace" }
  | { kind: "refresh"; scope: RefreshScope }
  | { kind: "traverse"; direction: TraverseDirection; historyState: unknown }
  | { kind: "prefetch"; href: string }
  | { kind: "flightResponseArrived"; token: OperationToken; result: FlightResultV0 };

export type RequestedWork =
  | { kind: "flight"; href: string; mode: "push" | "replace" | "refresh" }
  | { direction: TraverseDirection; historyState: unknown; kind: "traverseFlight" }
  | { kind: "prefetch"; href: string };

export type CommitProposal = {
  preserveAbsentSlots: boolean;
  preserveElementIds: readonly string[];
  preservePreviousSlotIds: readonly string[];
  reason: "currentRootBoundary" | "interceptedCurrentRootBoundary" | "rootBoundaryUnknownFallback";
  targetSnapshot: RouteSnapshotV0;
};

export type NoCommitReason = "prefetchOnly";
export type HardNavigationReason = "interceptionProofRejected" | "rootBoundaryChanged";
export type RootBoundaryTransition =
  | "currentRootBoundary"
  | "rootBoundaryChanged"
  | "rootBoundaryUnknownFallback";

export type NavigationDecisionV0 =
  | {
      kind: "requestWork";
      token: OperationToken;
      work: RequestedWork;
      trace: NavigationTrace;
    }
  | {
      kind: "proposeCommit";
      token: OperationToken;
      proposal: CommitProposal;
      trace: NavigationTrace;
    }
  | {
      kind: "noCommit";
      token: OperationToken;
      reason: NoCommitReason;
      trace: NavigationTrace;
    }
  | {
      kind: "hardNavigate";
      token: OperationToken;
      url: string;
      reason: HardNavigationReason;
      trace: NavigationTrace;
    };

export type FlightResultV0 = {
  href: string;
  targetSnapshot: RouteSnapshotV0;
};

export type NavigationPlannerInput = {
  // Graph-owned route topology is the semantic authority for root/layout/slot
  // decisions whenever the caller can supply it. Null keeps the legacy
  // snapshot-only path for low-level tests and unknown route shapes.
  routeManifest: RouteManifest | null;
  state: NavigationPlannerStateV0;
  event: NavigationEvent;
};

type RouteTopologySnapshot = {
  layoutIds: readonly string[];
  rootBoundaryId: string | null;
  rootLayoutTreePath: string | null;
  slotBindings: readonly ParallelSlotBindingSnapshotV0[];
};

type RouteTopologySlotBindingSource = "snapshot" | "manifestTarget";

const ROUTE_INTERCEPTION_CONTEXT_SEPARATOR = "\0";

function createRequestWorkDecision(options: {
  eventKind: NavigationEvent["kind"];
  state: NavigationPlannerStateV0;
  work: RequestedWork;
}): NavigationDecisionV0 {
  const traverseFields =
    options.work.kind === "traverseFlight" ? { traverseDirection: options.work.direction } : {};
  return {
    kind: "requestWork",
    token: options.state.nextOperationToken,
    work: options.work,
    trace: createNavigationTrace(NavigationTraceReasonCodes.requestWork, {
      eventKind: options.eventKind,
      targetHref: getRequestedWorkTargetHref(options.work),
      ...traverseFields,
    }),
  };
}

function getRequestedWorkTargetHref(work: RequestedWork): string | null {
  switch (work.kind) {
    case "flight":
    case "prefetch":
      return work.href;
    case "traverseFlight":
      return null;
    default: {
      const _exhaustive: never = work;
      throw new Error("[vinext] Unknown requested navigation work: " + String(_exhaustive));
    }
  }
}

function createSnapshotRouteTopology(snapshot: RouteSnapshotV0): RouteTopologySnapshot {
  return {
    layoutIds: snapshot.layoutIds,
    rootBoundaryId: snapshot.rootBoundaryId,
    rootLayoutTreePath: snapshot.rootBoundaryId,
    slotBindings: snapshot.slotBindings,
  };
}

function stripInterceptionContextFromRouteId(routeId: string): string {
  const separatorIndex = routeId.indexOf(ROUTE_INTERCEPTION_CONTEXT_SEPARATOR);
  return separatorIndex === -1 ? routeId : routeId.slice(0, separatorIndex);
}

function getMatchedUrlPathname(matchedUrl: string): string {
  try {
    return new URL(matchedUrl, "https://vinext.local").pathname;
  } catch {
    const [withoutHash = ""] = matchedUrl.split("#");
    const [pathname = ""] = withoutHash.split("?");
    return pathname === "" ? "/" : pathname;
  }
}

function splitMatchedUrlIntoRouteParts(matchedUrl: string): string[] {
  return normalizePathnameForRouteMatch(getMatchedUrlPathname(matchedUrl))
    .split("/")
    .filter((part) => part.length > 0);
}

function findRouteManifestRouteByMatchedUrl(
  routeManifest: RouteManifest,
  matchedUrl: string,
): RouteManifestRoute | null {
  const urlParts = splitMatchedUrlIntoRouteParts(matchedUrl);

  // RouteManifest preserves buildAppRouteGraph's compareRoutes() order, so the
  // first pattern match follows the same static/dynamic/catch-all precedence as
  // request-time route matching instead of raw filesystem scan order.
  for (const route of routeManifest.segmentGraph.routes.values()) {
    if (matchRoutePattern(urlParts, route.patternParts) !== null) {
      return route;
    }
  }

  return null;
}

function routeManifestRouteMatchesUrl(route: RouteManifestRoute, matchedUrl: string): boolean {
  return matchRoutePattern(splitMatchedUrlIntoRouteParts(matchedUrl), route.patternParts) !== null;
}

function findRouteManifestRouteByIdOrMatchedUrl(options: {
  matchedUrl: string;
  routeId: string;
  routeManifest: RouteManifest;
}): RouteManifestRoute | null {
  const routeId = stripInterceptionContextFromRouteId(options.routeId);
  const route = options.routeManifest.segmentGraph.routes.get(routeId);
  if (route && routeManifestRouteMatchesUrl(route, options.matchedUrl)) {
    return route;
  }

  return findRouteManifestRouteByMatchedUrl(options.routeManifest, options.matchedUrl);
}

function findRouteManifestRouteForSnapshot(
  routeManifest: RouteManifest,
  snapshot: RouteSnapshotV0,
): RouteManifestRoute | null {
  if (snapshot.interception !== null) {
    return findRouteManifestRouteByIdOrMatchedUrl({
      matchedUrl: snapshot.interception.sourceMatchedUrl,
      routeId: snapshot.interception.sourceRouteId,
      routeManifest,
    });
  }

  return findRouteManifestRouteByIdOrMatchedUrl({
    matchedUrl: snapshot.matchedUrl,
    routeId: snapshot.routeId,
    routeManifest,
  });
}

function resolveRouteManifestSlotBindings(
  routeManifest: RouteManifest,
  route: RouteManifestRoute,
): readonly ParallelSlotBindingSnapshotV0[] {
  const bindings: ParallelSlotBindingSnapshotV0[] = [];
  for (const slotId of route.slotIds) {
    const binding = routeManifest.segmentGraph.slotBindings.get(`${route.id}::${slotId}`);
    if (!binding) continue;
    bindings.push({
      ownerLayoutId: binding.ownerLayoutId,
      slotId: binding.slotId,
      state: binding.state,
    });
  }

  return bindings.sort((left, right) => compareAppElementsSlotIds(left.slotId, right.slotId));
}

function resolveRouteManifestRootLayoutTreePath(
  routeManifest: RouteManifest,
  route: RouteManifestRoute,
): string | null {
  if (route.rootBoundaryId === null) return null;
  return routeManifest.segmentGraph.rootBoundaries.get(route.rootBoundaryId)?.treePath ?? null;
}

function resolveRouteTopologySnapshot(options: {
  routeManifest: RouteManifest | null;
  slotBindingSource: RouteTopologySlotBindingSource;
  snapshot: RouteSnapshotV0;
}): RouteTopologySnapshot {
  const route =
    options.routeManifest === null
      ? null
      : findRouteManifestRouteForSnapshot(options.routeManifest, options.snapshot);
  if (route === null || options.routeManifest === null) {
    return createSnapshotRouteTopology(options.snapshot);
  }

  // Intercepted targets carry the source route's tree topology, not the direct
  // target route's, so direct-target manifest slot bindings do not apply.
  const shouldUseManifestSlotBindings =
    options.slotBindingSource === "manifestTarget" && options.snapshot.interception === null;

  return {
    layoutIds: route.layoutIds,
    rootBoundaryId: route.rootBoundaryId,
    rootLayoutTreePath: resolveRouteManifestRootLayoutTreePath(options.routeManifest, route),
    slotBindings: shouldUseManifestSlotBindings
      ? resolveRouteManifestSlotBindings(options.routeManifest, route)
      : options.snapshot.slotBindings,
  };
}

function createRootBoundaryTraceFields(options: {
  currentRootLayoutTreePath: string | null;
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  nextRootLayoutTreePath: string | null;
  state: NavigationPlannerStateV0;
}): NavigationTraceFields {
  // Browser commit approval supplies lifecycle trace context before calling
  // the planner. This fallback exists for pure planner callers and tests; it
  // intentionally cannot invent lifecycle-only fields such as active nav id.
  if (options.state.traceFields) {
    return {
      ...options.state.traceFields,
      currentRootLayoutTreePath: options.currentRootLayoutTreePath,
      nextRootLayoutTreePath: options.nextRootLayoutTreePath,
    };
  }

  return createNavigationLifecycleTraceFields({
    currentRootLayoutTreePath: options.currentRootLayoutTreePath,
    currentVisibleCommitVersion: options.state.visibleCommitVersion,
    nextRootLayoutTreePath: options.nextRootLayoutTreePath,
    startedVisibleCommitVersion: options.event.token.baseVisibleCommitVersion,
  });
}

function classifyRootBoundaryTransition(
  currentRootBoundaryId: string | null,
  nextRootBoundaryId: string | null,
): RootBoundaryTransition {
  if (currentRootBoundaryId === null || nextRootBoundaryId === null) {
    // Both null directions intentionally share the fallback because unresolved
    // routes or legacy callers cannot prove either same-root reuse or root
    // changes from semantic topology.
    return "rootBoundaryUnknownFallback";
  }

  return currentRootBoundaryId === nextRootBoundaryId
    ? "currentRootBoundary"
    : "rootBoundaryChanged";
}

function resolveSameLayoutAncestorPersistence(
  currentSnapshot: RouteSnapshotV0,
  targetSnapshot: RouteSnapshotV0,
): readonly string[] {
  return resolveSameLayoutAncestorPersistenceForTopologies(
    createSnapshotRouteTopology(currentSnapshot),
    createSnapshotRouteTopology(targetSnapshot),
  );
}

function resolveSameLayoutAncestorPersistenceForTopologies(
  currentTopology: RouteTopologySnapshot,
  targetTopology: RouteTopologySnapshot,
): readonly string[] {
  if (
    classifyRootBoundaryTransition(
      currentTopology.rootBoundaryId,
      targetTopology.rootBoundaryId,
    ) !== "currentRootBoundary"
  ) {
    return [];
  }

  const commonLayoutIds: string[] = [];
  const maxLength = Math.min(currentTopology.layoutIds.length, targetTopology.layoutIds.length);
  for (let index = 0; index < maxLength; index++) {
    const layoutId = currentTopology.layoutIds[index];
    if (layoutId !== targetTopology.layoutIds[index]) break;
    commonLayoutIds.push(layoutId);
  }
  return commonLayoutIds;
}

function resolveMountedParallelSlotPersistence(
  currentSnapshot: RouteSnapshotV0,
  targetSnapshot: RouteSnapshotV0,
): readonly string[] {
  const preservedLayoutIds = resolveSameLayoutAncestorPersistence(currentSnapshot, targetSnapshot);
  return resolveMountedParallelSlotPersistenceForLayouts(currentSnapshot, preservedLayoutIds);
}

function resolveMountedParallelSlotPersistenceForLayouts(
  currentSnapshot: RouteSnapshotV0,
  preservedLayoutIds: readonly string[],
): readonly string[] {
  if (preservedLayoutIds.length === 0) return [];
  const preservedLayoutIdSet = new Set(preservedLayoutIds);

  const preservedSlotIds: string[] = [];
  const seenSlotIds = new Set<string>();
  for (const slot of currentSnapshot.mountedParallelSlots) {
    if (slot.ownerLayoutId === null) continue;
    if (!preservedLayoutIdSet.has(slot.ownerLayoutId)) continue;
    if (seenSlotIds.has(slot.slotId)) continue;

    preservedSlotIds.push(slot.slotId);
    seenSlotIds.add(slot.slotId);
  }
  return preservedSlotIds;
}

function resolveCurrentRootBoundaryElementPersistence(
  currentSnapshot: RouteSnapshotV0,
  targetSnapshot: RouteSnapshotV0,
): readonly string[] {
  const preservedLayoutIds = resolveSameLayoutAncestorPersistence(currentSnapshot, targetSnapshot);
  // Non-commit consumers still receive the legacy mounted-slot element list.
  // Commit promotion uses preservePreviousSlotIds instead so default/unmatched
  // slot reuse requires route-state proof.
  return [
    ...preservedLayoutIds,
    ...resolveMountedParallelSlotPersistenceForLayouts(currentSnapshot, preservedLayoutIds),
  ];
}

function resolveCurrentRootBoundaryCommitElementPersistence(options: {
  currentTopology: RouteTopologySnapshot;
  lane: OperationLane;
  targetTopology: RouteTopologySnapshot;
}): readonly string[] {
  // Commit element persistence only keeps layout IDs. Default/unmatched slot
  // reuse is handled separately by preservePreviousSlotIds, using slot-binding
  // metadata as proof; payloads without __slotBindings get no semantic reuse.
  // resolveCurrentRootBoundaryCommitSlotPersistence recomputes this same
  // ancestor set; planner correctness relies on both calls agreeing so any
  // preserved slot's owner layout is also present in preserveElementIds.
  return resolveSameLayoutAncestorPersistenceForTopologies(
    options.currentTopology,
    options.targetTopology,
  );
}

function resolveCurrentRootBoundaryCommitSlotPersistence(options: {
  currentTopology: RouteTopologySnapshot;
  lane: OperationLane;
  targetTopology: RouteTopologySnapshot;
}): readonly string[] {
  if (options.lane === "traverse") return [];

  const preservedLayoutIds = resolveSameLayoutAncestorPersistenceForTopologies(
    options.currentTopology,
    options.targetTopology,
  );
  if (preservedLayoutIds.length === 0) return [];

  return resolveDefaultOrUnmatchedSlotPersistenceForLayouts({
    currentSlotBindings: options.currentTopology.slotBindings,
    preservedLayoutIds,
    targetSlotBindings: options.targetTopology.slotBindings,
  });
}

/**
 * Default/unmatched slot preservation law:
 *
 * A target default/unmatched slot may reuse previous content only when:
 * - the slot's owner layout is part of the preserved layout ancestor set;
 * - the current visible snapshot proves the same slot had renderable content;
 * - the navigation is not a traversal.
 *
 * Wire absence and UNMATCHED_SLOT markers are not semantic proof.
 */
function resolveDefaultOrUnmatchedSlotPersistenceForLayouts(options: {
  currentSlotBindings: readonly ParallelSlotBindingSnapshotV0[];
  preservedLayoutIds: readonly string[];
  targetSlotBindings: readonly ParallelSlotBindingSnapshotV0[];
}): readonly string[] {
  const preservedLayoutIdSet = new Set(options.preservedLayoutIds);
  const slotIdsWithContent = new Set<string>();
  for (const binding of options.currentSlotBindings) {
    if (binding.state === "unmatched") continue;
    slotIdsWithContent.add(binding.slotId);
  }

  const preservedSlotIds: string[] = [];
  const seenSlotIds = new Set<string>();
  for (const binding of options.targetSlotBindings) {
    if (binding.ownerLayoutId === null) continue;
    if (!preservedLayoutIdSet.has(binding.ownerLayoutId)) continue;
    if (binding.state === "active") continue;
    if (!slotIdsWithContent.has(binding.slotId)) continue;
    if (seenSlotIds.has(binding.slotId)) continue;

    preservedSlotIds.push(binding.slotId);
    seenSlotIds.add(binding.slotId);
  }
  return preservedSlotIds.sort(compareAppElementsSlotIds);
}

type VisibleInterceptionSourceIdentity = {
  matchedUrl: string;
  routeId: string;
};

type InterceptedPreservationValidation =
  | {
      kind: "approved";
      preserveElementIds: readonly string[];
      preservePreviousSlotIds: readonly string[];
    }
  | {
      kind: "rejected";
      reasonCode: NavigationTraceReasonCode;
    };

function getVisibleInterceptionSourceIdentity(
  snapshot: RouteSnapshotV0,
): VisibleInterceptionSourceIdentity {
  if (snapshot.interception) {
    return {
      matchedUrl: snapshot.interception.sourceMatchedUrl,
      routeId: snapshot.interception.sourceRouteId,
    };
  }
  return {
    matchedUrl: snapshot.matchedUrl,
    routeId: snapshot.routeId,
  };
}

function createInterceptionProofRejectedDecision(options: {
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  reasonCode: NavigationTraceReasonCode;
  traceFields: NavigationTraceFields;
}): NavigationDecisionV0 {
  return {
    kind: "hardNavigate",
    reason: "interceptionProofRejected",
    token: options.event.token,
    trace: createNavigationTrace(options.reasonCode, options.traceFields),
    url: options.event.result.href,
  };
}

function validateInterceptedPreservation(options: {
  currentSnapshot: RouteSnapshotV0;
  currentTopology: RouteTopologySnapshot;
  targetSnapshot: RouteSnapshotV0;
  targetTopology: RouteTopologySnapshot;
}): InterceptedPreservationValidation {
  const proof = options.targetSnapshot.interception;
  if (!proof) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedMissingProof,
    };
  }

  if (proof.targetMatchedUrl !== options.targetSnapshot.matchedUrl) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedTargetMismatch,
    };
  }

  const sourceIdentity = getVisibleInterceptionSourceIdentity(options.currentSnapshot);
  if (
    proof.sourceMatchedUrl !== sourceIdentity.matchedUrl ||
    proof.sourceRouteId !== sourceIdentity.routeId
  ) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedUnknownSource,
    };
  }

  const preservedLayoutIds = resolveSameLayoutAncestorPersistenceForTopologies(
    options.currentTopology,
    options.targetTopology,
  );
  if (preservedLayoutIds.length === 0) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedIncompatibleRoot,
    };
  }

  const preservedLayoutIdSet = new Set(preservedLayoutIds);
  const targetSlotBinding = options.targetTopology.slotBindings.find(
    (binding) => binding.slotId === proof.slotId,
  );
  if (
    !targetSlotBinding ||
    targetSlotBinding.state !== "active" ||
    targetSlotBinding.ownerLayoutId === null ||
    !preservedLayoutIdSet.has(targetSlotBinding.ownerLayoutId)
  ) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedMissingSlotProof,
    };
  }

  const preservePreviousSlotIds = resolveDefaultOrUnmatchedSlotPersistenceForLayouts({
    currentSlotBindings: options.currentTopology.slotBindings,
    preservedLayoutIds,
    targetSlotBindings: options.targetTopology.slotBindings,
  }).filter((slotId) => slotId !== proof.slotId);

  return {
    kind: "approved",
    preserveElementIds: preservedLayoutIds,
    preservePreviousSlotIds,
  };
}

function planFlightResponseArrived(options: {
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  routeManifest: RouteManifest | null;
  state: NavigationPlannerStateV0;
}): NavigationDecisionV0 {
  const targetSnapshot = options.event.result.targetSnapshot;
  const currentTopology = resolveRouteTopologySnapshot({
    routeManifest: options.routeManifest,
    slotBindingSource: "snapshot",
    snapshot: options.state.visibleSnapshot,
  });
  const targetTopology = resolveRouteTopologySnapshot({
    routeManifest: options.routeManifest,
    slotBindingSource: "manifestTarget",
    snapshot: targetSnapshot,
  });
  const traceFields = createRootBoundaryTraceFields({
    currentRootLayoutTreePath: currentTopology.rootLayoutTreePath,
    event: options.event,
    nextRootLayoutTreePath: targetTopology.rootLayoutTreePath,
    state: options.state,
  });

  if (options.event.token.lane === "prefetch") {
    return {
      kind: "noCommit",
      reason: "prefetchOnly",
      token: options.event.token,
      trace: createNavigationTrace(NavigationTraceReasonCodes.prefetchOnly, traceFields),
    };
  }

  // interceptionContext is transport evidence, not authority. Normal payloads
  // can carry it when a request was sent from an intercepted visible world, so
  // only explicit __interception proof enters the preservation branch.
  const hasInterceptedPayload = targetSnapshot.interception !== null;
  if (hasInterceptedPayload) {
    const validation = validateInterceptedPreservation({
      currentSnapshot: options.state.visibleSnapshot,
      currentTopology,
      targetSnapshot,
      targetTopology,
    });
    if (validation.kind === "rejected") {
      return createInterceptionProofRejectedDecision({
        event: options.event,
        reasonCode: validation.reasonCode,
        traceFields,
      });
    }

    return {
      kind: "proposeCommit",
      proposal: {
        preserveAbsentSlots: false,
        preserveElementIds: validation.preserveElementIds,
        preservePreviousSlotIds: validation.preservePreviousSlotIds,
        reason: "interceptedCurrentRootBoundary",
        targetSnapshot,
      },
      token: options.event.token,
      trace: createNavigationTrace(
        NavigationTraceReasonCodes.interceptedCommitCurrent,
        traceFields,
      ),
    };
  }

  const transition = classifyRootBoundaryTransition(
    currentTopology.rootBoundaryId,
    targetTopology.rootBoundaryId,
  );

  if (transition === "rootBoundaryChanged") {
    return {
      kind: "hardNavigate",
      reason: "rootBoundaryChanged",
      token: options.event.token,
      trace: createNavigationTrace(NavigationTraceReasonCodes.rootBoundaryChanged, traceFields),
      url: options.event.result.href,
    };
  }

  if (transition === "rootBoundaryUnknownFallback") {
    // Unknown root identity is an uncertainty fallback, not evidence that
    // reuse is safe. It remains only for callers without a manifest or routes
    // that cannot be matched back to RouteManifest topology.
    return {
      kind: "proposeCommit",
      proposal: {
        preserveAbsentSlots: true,
        preserveElementIds: [],
        preservePreviousSlotIds: [],
        reason: "rootBoundaryUnknownFallback",
        targetSnapshot,
      },
      token: options.event.token,
      trace: createNavigationTrace(NavigationTraceReasonCodes.rootBoundaryUnknown, traceFields),
    };
  }

  return {
    kind: "proposeCommit",
    proposal: {
      preserveAbsentSlots: false,
      preserveElementIds: resolveCurrentRootBoundaryCommitElementPersistence({
        currentTopology,
        lane: options.event.token.lane,
        targetTopology,
      }),
      preservePreviousSlotIds: resolveCurrentRootBoundaryCommitSlotPersistence({
        currentTopology,
        lane: options.event.token.lane,
        targetTopology,
      }),
      reason: "currentRootBoundary",
      targetSnapshot,
    },
    token: options.event.token,
    trace: createNavigationTrace(NavigationTraceReasonCodes.commitCurrent, traceFields),
  };
}

function planNavigation(input: NavigationPlannerInput): NavigationDecisionV0 {
  switch (input.event.kind) {
    case "navigate":
      return createRequestWorkDecision({
        eventKind: input.event.kind,
        state: input.state,
        work: {
          href: input.event.href,
          kind: "flight",
          mode: input.event.mode,
        },
      });
    case "refresh":
      return createRequestWorkDecision({
        eventKind: input.event.kind,
        state: input.state,
        work: {
          href: input.state.visibleSnapshot.displayUrl,
          kind: "flight",
          mode: "refresh",
        },
      });
    case "traverse":
      return createRequestWorkDecision({
        eventKind: input.event.kind,
        state: input.state,
        work: {
          direction: input.event.direction,
          historyState: input.event.historyState,
          kind: "traverseFlight",
        },
      });
    case "prefetch":
      return createRequestWorkDecision({
        eventKind: input.event.kind,
        state: input.state,
        work: {
          href: input.event.href,
          kind: "prefetch",
        },
      });
    case "flightResponseArrived":
      return planFlightResponseArrived({
        event: input.event,
        routeManifest: input.routeManifest,
        state: input.state,
      });
    default: {
      const _exhaustive: never = input.event;
      throw new Error("[vinext] Unknown navigation event: " + String(_exhaustive));
    }
  }
}

export const navigationPlanner = {
  classifyRootBoundaryTransition,
  plan: planNavigation,
  resolveCurrentRootBoundaryElementPersistence,
  resolveMountedParallelSlotPersistence,
  resolveSameLayoutAncestorPersistence,
};
