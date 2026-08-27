import type { WebSourceAnchor } from "../../webAccess/types";
import { normalizePublicWebUrl } from "../../webAccess/tavilyClient";

const ANCHOR_TOKEN_PREFIX = "LLMWEBSOURCEANCHOR";

export type WebSourcePopoverRow = {
  organization: string;
  title: string;
  url: string;
};

function anchorToken(index: number): string {
  return `${ANCHOR_TOKEN_PREFIX}${index}END`;
}

export function injectWebSourceAnchorTokens(
  markdown: string,
  anchors: readonly WebSourceAnchor[],
): string {
  let result = markdown;
  const sorted = anchors
    .map((anchor, index) => ({ anchor, index }))
    .filter(
      ({ anchor }) =>
        Number.isInteger(anchor.offset) &&
        anchor.offset >= 0 &&
        anchor.offset <= markdown.length &&
        anchor.sources.length > 0,
    )
    .sort((left, right) => right.anchor.offset - left.anchor.offset);
  for (const { anchor, index } of sorted) {
    result = `${result.slice(0, anchor.offset)}${anchorToken(index)}${result.slice(anchor.offset)}`;
  }
  return result;
}

function positionSourceCard(wrapper: HTMLElement, popover: HTMLElement): void {
  const doc = wrapper.ownerDocument;
  const win = doc.defaultView;
  if (!win) return;
  popover.classList.remove("llm-web-source-popover-below");
  popover.style.left = "0px";
  popover.style.maxHeight = "";
  const anchorRect = wrapper.getBoundingClientRect();
  const cardRect = popover.getBoundingClientRect();
  const viewportPadding = 12;
  const cardWidth = Math.min(
    cardRect.width || 360,
    Math.max(0, win.innerWidth - viewportPadding * 2),
  );
  const desiredLeft = anchorRect.right - cardWidth;
  const clampedLeft = Math.min(
    Math.max(viewportPadding, desiredLeft),
    Math.max(viewportPadding, win.innerWidth - cardWidth - viewportPadding),
  );
  popover.style.left = `${clampedLeft - anchorRect.left}px`;
  const availableAbove = Math.max(0, anchorRect.top - viewportPadding - 8);
  const availableBelow = Math.max(
    0,
    win.innerHeight - anchorRect.bottom - viewportPadding - 8,
  );
  const placeBelow =
    availableAbove < cardRect.height && availableBelow > availableAbove;
  if (placeBelow) {
    popover.classList.add("llm-web-source-popover-below");
  }
  popover.style.maxHeight = `${Math.floor(placeBelow ? availableBelow : availableAbove)}px`;
}

function launchWebSource(url: string): void {
  const safeUrl = normalizePublicWebUrl(url);
  Zotero.launchURL(safeUrl);
}

export function normalizeWebSourcePopoverRows(
  anchor: WebSourceAnchor,
): WebSourcePopoverRow[] {
  return anchor.sources.flatMap((source) => {
    try {
      const hostname =
        typeof source.hostname === "string" ? source.hostname.trim() : "";
      const organization =
        typeof source.organization === "string" && source.organization.trim()
          ? source.organization.trim().slice(0, 160)
          : hostname.slice(0, 160);
      const title =
        typeof source.title === "string" && source.title.trim()
          ? source.title.trim().slice(0, 500)
          : hostname.slice(0, 500);
      if (!organization || !title) return [];
      return [
        {
          organization,
          title,
          url: normalizePublicWebUrl(source.url),
        },
      ];
    } catch {
      return [];
    }
  });
}

function buildSourceIndicator(
  doc: Document,
  anchor: WebSourceAnchor,
): HTMLElement | null {
  const sources = normalizeWebSourcePopoverRows(anchor);
  if (!sources.length) return null;

  const wrapper = doc.createElement("span");
  wrapper.className = "llm-web-source-indicator";
  let removeOutsideListener: (() => void) | null = null;

  const chip = doc.createElement("button");
  chip.type = "button";
  chip.className = "llm-web-source-chip";
  chip.setAttribute("aria-label", "View web sources");
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-expanded", "false");

  const globe = doc.createElement("span");
  globe.className = "llm-web-source-globe";
  globe.setAttribute("aria-hidden", "true");
  chip.appendChild(globe);

  const popover = doc.createElement("span");
  popover.className = "llm-web-source-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Web sources");

  const close = () => {
    wrapper.classList.remove("expanded");
    chip.setAttribute("aria-expanded", "false");
    removeOutsideListener?.();
    removeOutsideListener = null;
  };

  const listenForOutsideClick = () => {
    if (removeOutsideListener) return;
    const onOutsideMouseDown = (event: Event) => {
      if (event.target && wrapper.contains(event.target as Node)) {
        return;
      }
      close();
    };
    doc.addEventListener("mousedown", onOutsideMouseDown, true);
    removeOutsideListener = () =>
      doc.removeEventListener("mousedown", onOutsideMouseDown, true);
  };

  for (const source of sources) {
    const row = doc.createElement("button");
    row.type = "button";
    row.className = "llm-web-source-row";
    row.title = `Open ${source.title}`;

    const organization = doc.createElement("span");
    organization.className = "llm-web-source-organization";
    organization.textContent = source.organization;

    const title = doc.createElement("span");
    title.className = "llm-web-source-title";
    title.textContent = source.title;

    row.append(organization, title);
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      launchWebSource(source.url);
      row.blur();
      close();
    });
    popover.appendChild(row);
  }

  const position = () => positionSourceCard(wrapper, popover);
  wrapper.addEventListener("mouseenter", position);
  wrapper.addEventListener("focusin", position);
  wrapper.addEventListener("focusout", () => {
    doc.defaultView?.setTimeout(() => {
      if (!wrapper.contains(doc.activeElement)) close();
    }, 0);
  });
  wrapper.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
    chip.blur();
  });
  chip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const expanded = wrapper.classList.toggle("expanded");
    chip.setAttribute("aria-expanded", String(expanded));
    if (expanded) {
      position();
      listenForOutsideClick();
    } else {
      close();
    }
  });

  wrapper.append(chip, popover);
  return wrapper;
}

export function decorateWebSourceIndicators(
  root: HTMLElement,
  doc: Document,
  anchors: readonly WebSourceAnchor[],
): void {
  if (!anchors.length) return;
  const tokenPattern = new RegExp(`${ANCHOR_TOKEN_PREFIX}(\\d+)END`, "g");
  const walker = doc.createTreeWalker(root, 4);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const textNode of textNodes) {
    const text = textNode.nodeValue || "";
    tokenPattern.lastIndex = 0;
    if (!tokenPattern.test(text)) continue;
    tokenPattern.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(text))) {
      if (match.index > cursor) {
        fragment.appendChild(
          doc.createTextNode(text.slice(cursor, match.index)),
        );
      }
      const anchor = anchors[Number(match[1])];
      const indicator = anchor ? buildSourceIndicator(doc, anchor) : null;
      if (indicator) fragment.appendChild(indicator);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}
