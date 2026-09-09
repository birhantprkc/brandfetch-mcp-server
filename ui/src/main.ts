import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps'

/** Subset of the Brand API response the card renders. */
interface BrandFormat {
  src: string
  format: string // svg | png | webp | jpeg ...
  background?: string | null
  width?: number | null
  height?: number | null
  size?: number | null
}

interface BrandLogo {
  type: string // logo | symbol | icon | other
  theme?: string | null // light | dark
  formats: BrandFormat[]
  tags?: string[]
}

interface BrandColor {
  hex: string
  type: string // accent | dark | light | brand | ...
  brightness?: number
}

interface BrandFont {
  name?: string | null
  type: string // title | body
  origin?: string // google | custom | system
}

interface BrandImage {
  type: string // banner | other
  theme?: string | null // light | dark
  formats: BrandFormat[]
}

interface BrandIndustry {
  name?: string
  score?: number
  parent?: { name?: string } | null
}

interface BrandCompany {
  employees?: number | null
  foundedYear?: number | null
  industries?: BrandIndustry[]
  kind?: string | null
  location?: {
    city?: string | null
    state?: string | null
    country?: string | null
    countryCode?: string | null
  } | null
}

/** One row of a brand_search response (also carries `verified`, unused here). */
interface SearchResult {
  brandId?: string
  domain?: string
  name?: string
  icon?: string
  claimed?: boolean
}

interface BrandLink {
  name: string
  url: string
}

interface Brand {
  id?: string
  name?: string | null
  domain?: string
  claimed?: boolean
  description?: string | null
  longDescription?: string | null
  links?: BrandLink[]
  logos?: BrandLogo[]
  colors?: BrandColor[]
  fonts?: BrandFont[]
  images?: BrandImage[]
  qualityScore?: number
  company?: BrandCompany
}

/** Brand Context API response subset (get_brand_context). */
interface BrandContext {
  identity?: {
    tagline?: string | null
    mission?: string | null
    description?: string | null
    tags?: string[]
  }
  positioning?: {
    value_proposition?: string | null
    target_audience?: { segment?: string; description?: string }[]
    products_and_services?: { name?: string; type?: string; description?: string }[]
  }
  brand?: {
    voice?: { summary?: string | null; attributes?: string[]; avoid?: string[] }
    style?: { summary?: string | null; attributes?: string[] }
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const skeletonEl = $('skeleton')
const cardEl = $('card')
const errorEl = $('error')
const tabsEl = $('tabs')
const panelsEl = $('panels')

const app = new App({ name: 'brandfetch-brand-card', version: '0.4.0' })

let brand: Brand | undefined
let availableTabIds: string[] = []
// One-shot deep link: get_brand's optional `view` argument opens the card on
// the matching tab ("okta brand voice" → Brand voice). Consumed on first
// render only, so in-widget brand switches keep the normal default.
let requestedView: string | undefined
const VIEW_TABS: Record<string, string> = {
  about: 'about',
  logos: 'logos',
  colors: 'colors',
  fonts: 'fonts',
  images: 'images',
  brand_voice: 'context',
}
// Panels whose asset grid can expand register a collapser here; leaving the
// tab restores the capped grid so the expansion never leaks into other tabs'
// height.
const galleryCollapsers = new Map<string, () => void>()
// Bumped whenever a brand selection starts or a render commits; an in-flight
// selection discards itself if a newer one has superseded it, so a slow
// get_brand response can never clobber a newer brand or write the wrong brand
// into the model context. (The context load guards on the displayed domain
// instead: a failed selection leaves the current brand up, and its pending
// context response must still be allowed to land.)
let selectionSeq = 0
// Renders that actually committed. The model-context queue keys on this, not
// on selectionSeq: a selection that FAILS bumps selectionSeq without changing
// the card, and must not discard the displayed brand's still-queued write.
let renderCommitSeq = 0

function applyHostContext(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return
  if (ctx.theme === 'dark' || ctx.theme === 'light') applyDocumentTheme(ctx.theme)
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables)
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts)
  // Keep interactive controls clear of host overlays (composer, mobile nav).
  const insets = ctx.safeAreaInsets
  if (insets) {
    document.body.style.padding = `${insets.top ?? 0}px ${insets.right ?? 0}px ${
      insets.bottom ?? 0
    }px ${insets.left ?? 0}px`
    scheduleReflow()
  }
}

function reportSize(): void {
  // Measure at max-content: scrollHeight never goes below the iframe's
  // current viewport, which is why the card used to grow but never shrink
  // back when leaving a tall tab.
  const root = document.documentElement
  const previous = root.style.height
  root.style.height = 'max-content'
  const height = Math.ceil(root.getBoundingClientRect().height)
  root.style.height = previous
  app.sendSizeChanged({ height }).catch(() => {})
}

function openExternal(url: string): void {
  app.openLink({ url }).catch(() => window.open(url, '_blank'))
}

/** Tiny element builder — this card has no framework. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

async function copyToClipboard(
  text: string,
  button: HTMLButtonElement,
  doneLabel = 'Copied',
): Promise<void> {
  const label = button.textContent
  try {
    await navigator.clipboard.writeText(text)
    button.textContent = doneLabel
  } catch {
    button.textContent = 'Copy failed'
  }
  setTimeout(() => (button.textContent = label), 1500)
}

/** Copy with the design-spec feedback: the given label element briefly reads "Copied". */
function copyWithLabelFeedback(text: string, labelEl: HTMLElement): void {
  const original = labelEl.textContent
  navigator.clipboard
    .writeText(text)
    .then(() => (labelEl.textContent = 'Copied'))
    .catch(() => (labelEl.textContent = 'Copy failed'))
  setTimeout(() => (labelEl.textContent = original), 1200)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function flashText(node: HTMLElement, text: string, ms = 2500): void {
  const label = node.textContent
  node.textContent = text
  setTimeout(() => (node.textContent = label), ms)
}

/* --------------------------------------------------------------- app height */

// Tabs render at their natural height and the card shrinks back when leaving
// a tall tab. The Logos layout sets the floor so
// switching to a short tab doesn't collapse the card below the primary view.
function applyMinHeight(): void {
  panelsEl.style.minHeight = ''
  if (!availableTabIds.includes('logos')) return
  const panel = document.getElementById('panel-logos')
  if (!panel) return
  const wasHidden = panel.classList.contains('hidden')
  if (wasHidden) {
    panel.style.cssText = 'visibility:hidden;position:absolute;left:0;right:0;top:0'
    panel.classList.remove('hidden')
  }
  const floor = panel.offsetHeight
  if (wasHidden) {
    panel.classList.add('hidden')
    panel.style.cssText = ''
  }
  if (floor > 0) panelsEl.style.minHeight = `${floor}px`
}

let reflowTimer: number | undefined
function scheduleReflow(): void {
  clearTimeout(reflowTimer)
  reflowTimer = window.setTimeout(() => {
    applyMinHeight()
    reportSize()
  }, 60)
}

const NARROW_WIDTH = 560

let lastWidth = 0
new ResizeObserver((entries) => {
  const width = entries[0]?.contentRect.width ?? 0
  if (Math.abs(width - lastWidth) > 1) {
    lastWidth = width
    document.body.classList.toggle('narrow', width < NARROW_WIDTH)
    if (brand) scheduleReflow()
  }
}).observe(document.body)

const TYPE_ORDER = ['logo', 'symbol', 'icon', 'other']

/** Every displayable asset, ordered logo > symbol > icon > other. Within a
 * type, theme "dark" (Brandfetch's dark-on-light artwork) leads so the default
 * selection previews well on the light tile; "light" variants stay browsable
 * via the thumbnail grid, shown on a dark tile instead. */
function collectAssets(logos: BrandLogo[]): BrandLogo[] {
  const themeRank = (theme: string | null | undefined) =>
    theme === 'dark' ? 0 : theme === 'light' ? 1 : 2
  const rank = (l: BrandLogo) => {
    const t = TYPE_ORDER.indexOf(l.type)
    return (t === -1 ? TYPE_ORDER.length : t) * 3 + themeRank(l.theme)
  }
  return logos.filter((l) => l.formats?.some((f) => f.src)).sort((a, b) => rank(a) - rank(b))
}

/** The asset tile is the INVERSE of the artwork: `theme: "light"` means light
 * artwork, which is only legible on a dark backdrop. No theme means a light
 * backdrop, and icons keep a light backdrop whatever their theme says, since
 * they usually ship with a filled background of their own (PRD-5043). */
function needsDarkTile(type: string, theme: string | null | undefined): boolean {
  return theme === 'light' && type !== 'icon'
}

/** "Logo", plus the theme when the brand has several variants of that type. */
function assetLabel(asset: BrandLogo, all: BrandLogo[]): string {
  const typeLabel = asset.type.charAt(0).toUpperCase() + asset.type.slice(1)
  const siblings = all.filter((l) => l.type === asset.type)
  return siblings.length > 1 && asset.theme ? `${typeLabel} · ${asset.theme}` : typeLabel
}

function showError(message: string): void {
  skeletonEl.classList.add('hidden')
  cardEl.classList.add('hidden')
  errorEl.textContent = message
  errorEl.classList.remove('hidden')
  reportSize()
}

/* ------------------------------------------------------------- downloading */

const FORMAT_MIME_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',', 2)[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// claude.ai saves files when the bytes are embedded inline (verified on
// PRD-5043) — it cannot fetch a linked URI itself, so the card fetches the
// bytes here (CDN CORS allows it) and hands them over embedded. The
// resource_link and in-page fallbacks cover other hosts.
type DownloadOutcome = 'ok' | 'declined' | 'unsupported'

async function downloadAsset(
  src: string,
  format: string,
  filename: string,
  button: HTMLButtonElement,
): Promise<DownloadOutcome> {
  button.disabled = true
  try {
    if (app.getHostCapabilities()?.downloadFile) {
      // The host supports downloads, so any failure past this point is a
      // decline (usually the user cancelling the host's confirm modal) — not
      // a blocked host, and the right-click workaround pitch would be wrong.
      try {
        const resp = await fetch(src)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const blob = await resp.blob()
        const result = await app.downloadFile({
          contents: [
            {
              type: 'resource',
              resource: {
                uri: `asset://${filename}`,
                mimeType: FORMAT_MIME_TYPES[format] ?? blob.type,
                blob: await blobToBase64(blob),
              },
            },
          ],
        })
        return result.isError ? 'declined' : 'ok'
      } catch {
        // In-iframe fetch failed: fall back to a linked URI the host fetches.
        const result = await app.downloadFile({
          contents: [
            {
              type: 'resource_link',
              uri: src,
              name: filename,
              mimeType: FORMAT_MIME_TYPES[format],
            },
          ],
        })
        return result.isError ? 'declined' : 'ok'
      }
    }
    // Hosts without ui/download-file: try an in-page blob download. Silently
    // ignored in sandboxes without allow-downloads, but works elsewhere.
    const resp = await fetch(src)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    return 'ok'
  } catch {
    return 'unsupported'
  } finally {
    button.disabled = false
  }
}

/* ---------------------------------------------------- gallery (logos/images) */

interface GalleryItem {
  /** Raw asset type, used for grouping and default selection. */
  type: string
  /** Asset type shown under the preview ("Logo", "Banner"). */
  label: string
  /** Longer description used for thumbnail tooltips, where variants differ. */
  title: string
  formats: BrandFormat[]
  onDark?: boolean
  filenameBase: string
}

const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M6 10l6 6 6-6M4 20h16"/></svg>'

function defaultFormat(item: GalleryItem, preferSvg: boolean): BrandFormat {
  const formats = item.formats
  return (
    (preferSvg
      ? formats.find((f) => f.format === 'svg')
      : formats.find((f) => f.format !== 'svg')) ?? formats[0]
  )
}

const TILE_LIGHT = '#f2f2f0'
const TILE_DARK = '#1f1f1e'

/** Keeps a tab's badge honest when the gallery drops unrenderable assets. */
function setTabCount(id: string, count: number): void {
  const badge = tabsEl.querySelector<HTMLElement>(`.tab[data-tab="${id}"] .tab-count`)
  if (badge) badge.textContent = String(count)
}

/** Whether an asset actually shows something once composited onto the tile it
 * will sit on. Some brand assets load fine but are drawn in ink that matches
 * their backdrop, which would leave an empty frame in the grid (PRD-5043).
 *
 * Fails open: a load error, a CORS-tainted canvas or a timeout all count as
 * renderable, so a false negative can never hide a good asset. */
function isRenderable(src: string, onDark: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(true), 4000)
    const probe = new Image()
    probe.crossOrigin = 'anonymous'
    probe.onerror = () => done(false)
    probe.onload = () => {
      try {
        const size = 48
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return done(true)
        ctx.fillStyle = onDark ? TILE_DARK : TILE_LIGHT
        ctx.fillRect(0, 0, size, size)
        const scale = Math.min(size / (probe.width || size), size / (probe.height || size))
        const w = (probe.width || size) * scale
        const h = (probe.height || size) * scale
        ctx.drawImage(probe, (size - w) / 2, (size - h) / 2, w, h)
        const { data } = ctx.getImageData(0, 0, size, size)
        const tile = onDark ? [31, 31, 30] : [242, 242, 240]
        let visible = 0
        for (let i = 0; i < data.length; i += 4) {
          const delta =
            Math.abs(data[i] - tile[0]) +
            Math.abs(data[i + 1] - tile[1]) +
            Math.abs(data[i + 2] - tile[2])
          if (delta > 24) visible++
        }
        // Anti-aliasing alone can tint a few pixels; require a real mark.
        done(visible / (size * size) > 0.005)
      } catch {
        done(true)
      }
    }
    probe.src = src
  })
}

/** Drops assets that would render as an empty frame, then re-renders. Runs
 * after first paint so the card is never held back by the probes. */
async function pruneUnrenderable(
  items: GalleryItem[],
  opts: { preferSvg: boolean; imageFit: boolean },
  render: (kept: GalleryItem[]) => void,
): Promise<void> {
  const verdicts = await Promise.all(
    items.map((entry) =>
      isRenderable(defaultFormat(entry, opts.preferSvg).src, Boolean(entry.onDark)),
    ),
  )
  const kept = items.filter((_, index) => verdicts[index])
  if (kept.length && kept.length !== items.length) {
    render(kept)
    scheduleReflow()
  }
}

/** Shared preview + thumbnail-grid + format control + actions block, used by
 * the Logos and Images tabs (PRD-5043 spec §2 and §6). */
function renderGallery(
  panel: HTMLElement,
  items: GalleryItem[],
  opts: { preferSvg: boolean; imageFit: boolean },
): void {
  panel.replaceChildren()
  if (!items.length) return
  // Open on the full lockup, falling back to the mark then the app icon.
  // Never `other` unless the brand has nothing else (PRD-5043).
  const preferredType = ['logo', 'symbol', 'icon'].find((t) => items.some((i) => i.type === t))
  let item = (preferredType && items.find((i) => i.type === preferredType)) || items[0]
  let format = defaultFormat(item, opts.preferSvg)

  const layout = el('div', 'g-layout')
  const preview = el('div', 'preview')
  if (opts.imageFit) preview.classList.add('image')
  // A single image is full width at a fixed 180px; everywhere else 180px is a
  // floor and the preview stretches to the thumbnail grid's height.
  if (opts.imageFit && items.length === 1) preview.classList.add('fixed')
  const img = el('img')
  img.alt = 'Brand asset preview'
  img.onload = scheduleReflow
  const canvas = el('div', 'preview-canvas')
  canvas.appendChild(img)
  const label = el('span', 'preview-label')
  const meta = el('span', 'preview-meta')
  const caption = el('div', 'preview-caption')
  caption.append(label, meta)
  preview.append(canvas, caption)
  layout.appendChild(preview)

  // At most 12 tiles: 11 thumbnails, with a "+N more" tile in the 12th slot
  // when the brand has more.
  // 11 thumbnails with "+N more" in the 12th cell; expanding continues the
  // same grid downward, one-way — the more-tile is replaced by the assets it
  // stood in for. Wider fixed grids read too small and too dense here, so
  // the columns auto-fill instead.
  const THUMB_CAP = 11
  const thumbs = el('div', 'g-thumbs')
  if (items.length > 1) {
    const addThumb = (entry: GalleryItem, index: number): void => {
      const thumb = el('button', 'thumb')
      if (entry.onDark) thumb.classList.add('on-dark')
      // Icons always run edge to edge; square assets whose format reports
      // background: null carry a baked-in background and get the same
      // treatment.
      const fmt = defaultFormat(entry, opts.preferSvg)
      const baked =
        fmt.background === null && typeof fmt.width === 'number' && fmt.width === fmt.height
      if (entry.type === 'icon' || baked) thumb.classList.add('fill')
      thumb.dataset.index = String(index)
      thumb.title = entry.title
      thumb.setAttribute('aria-label', entry.title)
      const thumbImg = el('img')
      thumbImg.alt = ''
      thumbImg.src = fmt.src
      thumbImg.onload = scheduleReflow
      thumb.appendChild(thumbImg)
      thumb.onclick = () => selectItem(entry)
      thumbs.appendChild(thumb)
    }
    const syncPressed = (): void => {
      for (const thumb of thumbs.querySelectorAll<HTMLButtonElement>('.thumb')) {
        if (thumb.dataset.index === undefined) continue
        thumb.setAttribute(
          'aria-pressed',
          String(thumb.dataset.index === String(items.indexOf(item))),
        )
      }
    }
    // Exactly 12 assets fit as-is; only use the 12th cell for the more-tile
    // when something would actually be hidden.
    if (items.length <= THUMB_CAP + 1) {
      items.forEach((entry, index) => addThumb(entry, index))
      galleryCollapsers.delete(panel.id)
    } else {
      const hidden = items.length - THUMB_CAP
      const renderCollapsed = (): void => {
        thumbs.replaceChildren()
        items.slice(0, THUMB_CAP).forEach((entry, index) => addThumb(entry, index))
        const more = el('button', 'thumb view-more', `+${hidden} more`)
        more.title = 'View more'
        more.setAttribute('aria-label', `View ${hidden} more assets`)
        more.onclick = () => {
          more.remove()
          items.slice(THUMB_CAP).forEach((entry, i) => addThumb(entry, THUMB_CAP + i))
          syncPressed()
          scheduleReflow()
        }
        thumbs.appendChild(more)
        syncPressed()
      }
      renderCollapsed()
      // Leaving the tab collapses the grid back to the capped state —
      // expansion is per-visit, not sticky, so one expansion never inflates
      // the height floor for the other tabs.
      galleryCollapsers.set(panel.id, renderCollapsed)
    }
    layout.appendChild(thumbs)
  }
  panel.appendChild(layout)

  const footer = el('div', 'asset-footer')
  footer.appendChild(el('span', 'avail-label', 'Available in'))
  const seg = el('div', 'seg')
  footer.appendChild(seg)
  const actions = el('div', 'g-actions')
  const downloadBtn = el('button', 'btn primary')
  const downloadLabel = el('span', undefined, 'Download asset')
  const downloadIcon = el('span', 'btn-icon')
  downloadIcon.innerHTML = DOWNLOAD_ICON
  downloadBtn.append(downloadLabel, downloadIcon)
  const copyBtn = el('button', 'btn contrast', 'Copy URL')
  actions.append(downloadBtn, copyBtn)
  footer.appendChild(actions)
  panel.appendChild(footer)

  const hint = el(
    'div',
    'muted hidden',
    'This host blocks downloads started from cards. Right-click (or long-press) the image and choose “Save image as…”, or use Copy URL.',
  )
  panel.appendChild(hint)

  downloadBtn.onclick = async () => {
    const filename = `${item.filenameBase}.${format.format}`
    const outcome = await downloadAsset(format.src, format.format, filename, downloadBtn)
    if (outcome === 'declined') {
      // The user cancelled the host's own confirm dialog — nothing is broken,
      // and any message here reads as a bug, so say nothing.
    } else if (outcome === 'unsupported') {
      flashText(downloadLabel, 'Right-click image to save')
      hint.classList.remove('hidden')
      scheduleReflow()
    }
  }
  copyBtn.onclick = () => void copyToClipboard(format.src, copyBtn)

  function selectFormat(next: BrandFormat): void {
    format = next
    img.src = next.src
    // Metadata of the selected format; only the parts the API provides.
    const parts = [next.format?.toUpperCase()]
    if (typeof next.size === 'number' && next.size > 0) parts.push(formatBytes(next.size))
    if (typeof next.width === 'number' && typeof next.height === 'number') {
      parts.push(`${next.width}x${next.height}`)
    }
    meta.textContent = parts.filter(Boolean).join(' • ')
    downloadLabel.textContent = `Download ${next.format ? next.format.toUpperCase() : 'asset'}`
    for (const btn of seg.querySelectorAll<HTMLButtonElement>('button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.format === next.format))
    }
  }

  function selectItem(next: GalleryItem): void {
    item = next
    preview.classList.toggle('on-dark', Boolean(next.onDark))
    label.textContent = next.label
    // Only the formats this asset actually has, in canonical order — the API
    // returns them inconsistently ordered.
    const FORMAT_ORDER = ['svg', 'png', 'webp', 'jpeg', 'jpg']
    const orderedFormats = [...next.formats].sort((a, b) => {
      const rank = (f: BrandFormat) => {
        const i = FORMAT_ORDER.indexOf(f.format)
        return i === -1 ? FORMAT_ORDER.length : i
      }
      return rank(a) - rank(b)
    })
    seg.replaceChildren()
    for (const f of orderedFormats) {
      const btn = el('button', undefined, f.format)
      btn.dataset.format = f.format
      btn.onclick = () => selectFormat(f)
      seg.appendChild(btn)
    }
    selectFormat(defaultFormat(next, opts.preferSvg))
    // The view-more tile has no index and is skipped.
    for (const thumb of thumbs.querySelectorAll<HTMLButtonElement>('.thumb')) {
      if (thumb.dataset.index === undefined) continue
      thumb.setAttribute(
        'aria-pressed',
        String(thumb.dataset.index === String(items.indexOf(next))),
      )
    }
  }

  selectItem(item)
}

function renderLogos(assets: BrandLogo[]): void {
  const items: GalleryItem[] = assets.map((asset) => ({
    type: asset.type,
    label: asset.type.charAt(0).toUpperCase() + asset.type.slice(1),
    title: assetLabel(asset, assets),
    formats: asset.formats.filter((f) => f.src),
    onDark: needsDarkTile(asset.type, asset.theme),
    filenameBase: `${brand?.domain ?? 'brand'}-${asset.type}${
      asset.theme ? `-${asset.theme}` : ''
    }`,
  }))
  const opts = { preferSvg: true, imageFit: false }
  const render = (list: GalleryItem[]) => {
    renderGallery($('panel-logos'), list, opts)
    setTabCount('logos', list.length)
  }
  render(items)
  void pruneUnrenderable(items, opts, render)
}

function renderImages(images: BrandImage[]): void {
  const items: GalleryItem[] = images
    .map((image, index) => ({
      type: image.type,
      label: image.type,
      title: image.type,
      onDark: needsDarkTile(image.type, image.theme),
      formats: (image.formats ?? []).filter((f) => f.src),
      filenameBase: `${brand?.domain ?? 'brand'}-${image.type}-${index + 1}`,
    }))
    .filter((entry) => entry.formats.length > 0)
  const opts = { preferSvg: false, imageFit: true }
  const render = (list: GalleryItem[]) => {
    renderGallery($('panel-images'), list, opts)
    setTabCount('images', list.length)
  }
  render(items)
  void pruneUnrenderable(items, opts, render)
}

/* --------------------------------------------------------------- colors tab */

// Colour priority: accent leads, then brand, light, dark; anything the API
// isn't in this list keeps its relative position at the end.
const COLOR_TYPE_ORDER = ['accent', 'brand', 'light', 'dark']

function renderColors(colors: BrandColor[]): void {
  const grid = $('color-grid')
  grid.replaceChildren()
  const rank = (c: BrandColor) => {
    const index = COLOR_TYPE_ORDER.indexOf(c.type)
    return index === -1 ? COLOR_TYPE_ORDER.length : index
  }
  // Every color the API returns, repeated "brand" roles included.
  for (const color of [...colors].sort((a, b) => rank(a) - rank(b))) {
    const card = el('button', 'color-card')
    card.title = 'Copy HEX'
    const swatch = el('span', 'color-swatch')
    swatch.style.background = color.hex
    const role = el('span', 'color-role', color.type)
    const hex = el('span', 'color-hex', color.hex.toUpperCase())
    card.append(swatch, role, hex)
    card.onclick = () => copyWithLabelFeedback(color.hex.toUpperCase(), role)
    grid.appendChild(card)
  }
}

/* ---------------------------------------------------------------- fonts tab */

const FONT_ORIGIN_LABELS: Record<string, string> = {
  google: 'Google Font',
  custom: 'Custom font',
  system: 'System font',
}

const FONT_TYPE_ORDER = ['title', 'body']

function renderFonts(fonts: BrandFont[]): void {
  const list = $('font-list')
  list.replaceChildren()
  // Title before body regardless of payload order; API order kept within a
  // group.
  const ordered = [...fonts].sort((a, b) => {
    const rank = (f: BrandFont) => {
      const i = FONT_TYPE_ORDER.indexOf(f.type)
      return i === -1 ? FONT_TYPE_ORDER.length : i
    }
    return rank(a) - rank(b)
  })
  for (const font of ordered) {
    if (!font.name) continue
    const name = font.name
    const row = el('button', 'font-row')
    row.title = 'Copy font name'
    row.appendChild(el('span', 'font-sample', 'Aa'))
    const meta = el('div', 'font-meta')
    meta.appendChild(el('div', 'font-name', name))
    const details = [
      font.type === 'title' ? 'Title' : font.type === 'body' ? 'Body' : font.type,
      font.origin ? (FONT_ORIGIN_LABELS[font.origin] ?? font.origin) : undefined,
    ].filter(Boolean)
    const detail = el('div', 'font-detail', details.join(' • '))
    meta.appendChild(detail)
    row.appendChild(meta)
    row.onclick = () => copyWithLabelFeedback(name, detail)
    // Google-hosted fonts link out to their specimen page; the row click
    // still copies the name.
    if (font.origin === 'google') {
      // span, not button: the row itself is already a button and buttons
      // cannot nest.
      const link = el('span', 'font-link')
      link.appendChild(el('span', undefined, 'Open Google Font'))
      const linkIcon = el('span', 'btn-icon')
      linkIcon.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>'
      link.appendChild(linkIcon)
      link.title = `Open ${name} on Google Fonts`
      link.setAttribute('role', 'link')
      link.tabIndex = 0
      const open = (event: Event) => {
        event.stopPropagation()
        openExternal(`https://fonts.google.com/specimen/${name.trim().replace(/\s+/g, '+')}`)
      }
      link.onclick = open
      link.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') open(event)
      }
      row.appendChild(link)
    }
    list.appendChild(row)
  }
}

/* -------------------------------------------------------------- company tab */

// The API's documented band lower bounds; en dash with no spaces per the
// house style. No "employees" suffix: the row label
// already says Company size.
const EMPLOYEE_BUCKETS: Record<number, string> = {
  1: '1',
  2: '2\u201310',
  11: '11\u201350',
  51: '51\u2013200',
  201: '201\u2013500',
  501: '501\u20131,000',
  1001: '1,001\u20135,000',
  5001: '5,001\u201310,000',
  10001: '10,001+',
}

const COMPANY_KIND_LABELS: Record<string, string> = {
  EDUCATIONAL: 'Educational',
  GOVERNMENT_AGENCY: 'Government agency',
  NON_PROFIT: 'Non-profit',
  PARTNERSHIP: 'Partnership',
  PRIVATELY_HELD: 'Privately held',
  PUBLIC_COMPANY: 'Public company',
  SELF_EMPLOYED: 'Self-employed',
  SELF_OWNED: 'Self-owned',
}

/** The most specific industry entries: the ones that have a parent (leaf
 * nodes in the taxonomy), best score first, at most two (PRD-5045 5.1). */
function specificIndustries(industries: BrandIndustry[] | undefined): string[] {
  const all = (industries ?? []).filter((i) => i.name)
  const leaves = all.filter((i) => i.parent?.name)
  const picked = (leaves.length ? leaves : all).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  return picked.slice(0, 2).map((i) => i.name as string)
}

/** `city, state, countryCode`, all in full — the API has no state
 * abbreviations and we deliberately don't keep a table of them. */
function hqLabel(company: BrandCompany | undefined): string | undefined {
  const location = company?.location ?? {}
  return (
    [location.city, location.state, location.countryCode].filter(Boolean).join(', ') || undefined
  )
}

// Solid monochrome glyphs (Simple Icons style) keyed by the `links[].name`
// slug; unknown slugs fall back to a generic link icon rather than being
// dropped. `twitter` renders the X mark; the API key stays `twitter`.
const SOCIAL_ICON_PATHS: Record<string, string> = {
  facebook:
    '<path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>',
  twitter:
    '<path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/>',
  x: '<path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/>',
  instagram:
    '<path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/>',
  youtube:
    '<path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>',
  linkedin:
    '<path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>',
  github:
    '<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
}
const GENERIC_LINK_PATH =
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'

function socialLink(link: BrandLink): HTMLButtonElement {
  const slug = (link.name || '').toLowerCase()
  const label = slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Website'
  const btn = el('button', 'social-link')
  btn.title = label
  btn.setAttribute('aria-label', label)
  const glyph = SOCIAL_ICON_PATHS[slug]
  btn.innerHTML = glyph
    ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">${glyph}</svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GENERIC_LINK_PATH}</svg>`
  btn.onclick = () => openExternal(link.url)
  return btn
}

/** One row of the About context list. Accepts several values (stacked). */
function addAboutFact(list: HTMLElement, label: string, value?: string | string[]): void {
  const values = (Array.isArray(value) ? value : [value]).filter(Boolean) as string[]
  if (!values.length) return
  const fact = el('div', 'fact')
  fact.appendChild(el('div', 'fact-label', label))
  for (const v of values) fact.appendChild(el('div', 'fact-value', v))
  list.appendChild(fact)
}

function employeeBand(employees: number): string {
  return EMPLOYEE_BUCKETS[employees] ?? String(employees)
}

// About: identity text left, company context right (PRD-5045 5.1). Rows with
// no data are omitted entirely — no empty containers, no dashes.
function renderAbout(data: Brand): void {
  const panel = $('panel-about')
  panel.replaceChildren()

  const left = el('div', 'about-left')
  if (data.description) {
    left.appendChild(el('div', 'section-label', 'Description'))
    left.appendChild(el('p', 'company-desc', data.description))
  }
  if (data.longDescription && data.longDescription !== data.description) {
    const details = el('details', 'long-desc')
    details.appendChild(el('summary', undefined, 'Read more…'))
    for (const paragraph of data.longDescription.split(/\n+/)) {
      if (paragraph.trim()) details.appendChild(el('p', undefined, paragraph.trim()))
    }
    details.ontoggle = scheduleReflow
    left.appendChild(details)
  }
  const links = (data.links ?? []).filter((l) => l.url)
  if (links.length) {
    left.appendChild(el('div', 'section-label', 'Social Links'))
    const row = el('div', 'social-row')
    for (const link of links) row.appendChild(socialLink(link))
    left.appendChild(row)
  }

  const company = data.company ?? {}
  const facts = el('div', 'about-facts')
  addAboutFact(facts, 'Industry', specificIndustries(company.industries))
  addAboutFact(
    facts,
    'Company size',
    company.employees != null ? employeeBand(company.employees) : undefined,
  )
  addAboutFact(
    facts,
    'Founded year',
    company.foundedYear != null ? String(company.foundedYear) : undefined,
  )
  addAboutFact(facts, 'Location', hqLabel(company))
  addAboutFact(
    facts,
    'Company kind',
    company.kind ? (COMPANY_KIND_LABELS[company.kind] ?? company.kind) : undefined,
  )

  if (!left.childElementCount && !facts.childElementCount) {
    panel.appendChild(el('p', 'muted', 'No company data available.'))
    return
  }
  const cols = el('div', 'about-cols')
  if (left.childElementCount) cols.appendChild(left)
  if (facts.childElementCount) cols.appendChild(facts)
  panel.appendChild(cols)
}

/* -------------------------------------------------------------- context tab */

let contextState: 'idle' | 'loading' | 'done' = 'idle'
// Only the newest context request may touch state: an older in-flight request
// for the SAME domain (an A→B→A switch) passes a domain-only check, and its
// late rejection would clobber the newer request's loading state.
let contextSeq = 0

function contextMessage(text: string, retry = false): void {
  const panel = $('panel-context')
  panel.replaceChildren(el('p', 'muted', text))
  if (retry) {
    const btn = el('button', 'btn small', 'Retry')
    btn.onclick = () => {
      contextState = 'idle'
      void loadContext()
    }
    panel.appendChild(btn)
  }
  scheduleReflow()
}

function addChips(
  panel: HTMLElement,
  label: string,
  values: string[] | undefined,
  extraClass = '',
): void {
  const items = (values ?? []).filter(Boolean)
  if (!items.length) return
  panel.appendChild(el('div', 'section-label', label))
  const row = el('div', 'chips')
  for (const value of items) {
    // Sentence case, first letter only ("Jargon-heavy language").
    const cased = value.charAt(0).toUpperCase() + value.slice(1)
    row.appendChild(el('span', `chip static ${extraClass}`.trim(), cased))
  }
  panel.appendChild(row)
}

// Brand voice only: summary left (clamped behind Read more), attribute and
// avoid chips on the side.
function renderContext(ctx: BrandContext): void {
  const panel = $('panel-context')
  panel.replaceChildren()

  const voice = ctx.brand?.voice
  const attributes = (voice?.attributes ?? []).filter(Boolean)
  const avoid = (voice?.avoid ?? []).filter(Boolean)
  if (!voice?.summary && !attributes.length && !avoid.length) {
    panel.appendChild(el('p', 'muted', 'No brand voice available.'))
    scheduleReflow()
    return
  }

  const cols = el('div', 'about-cols')
  const left = el('div', 'about-left')
  if (voice?.summary) {
    left.appendChild(el('div', 'section-label', 'Brand voice'))
    const summary = el('p', 'voice-summary clamped company-desc', voice.summary)
    left.appendChild(summary)
    const toggle = el('button', 'read-more', 'Read more…')
    toggle.onclick = () => {
      summary.classList.remove('clamped')
      toggle.remove()
      scheduleReflow()
    }
    left.appendChild(toggle)
    // Only offer Read more when the clamp actually cuts something off.
    requestAnimationFrame(() => {
      if (summary.scrollHeight <= summary.clientHeight + 2) toggle.remove()
    })
  }

  const side = el('div', 'about-facts')
  addChips(side, 'Attributes', attributes, 'good')
  addChips(side, 'Avoid', avoid, 'avoid')

  if (left.childElementCount) cols.appendChild(left)
  if (side.childElementCount) cols.appendChild(side)
  panel.appendChild(cols)
  scheduleReflow()
}

async function loadContext(): Promise<void> {
  if (contextState !== 'idle') return
  const domain = brand?.domain
  if (!domain) {
    contextState = 'done'
    contextMessage('No domain available for this brand.')
    return
  }
  if (!app.getHostCapabilities()?.serverTools) {
    contextState = 'done'
    contextMessage(
      'This host does not let the card load brand context. Ask the assistant for it instead.',
    )
    return
  }
  contextState = 'loading'
  contextMessage('Loading brand context…')
  const token = ++contextSeq
  try {
    const result = await app.callServerTool({ name: 'get_brand_context', arguments: { domain } })
    // Superseded by a newer request, or the card switched brands — either
    // way this response no longer owns the context state.
    if (token !== contextSeq || brand?.domain !== domain) return
    const text = result.content?.find((c) => c.type === 'text')
    if (result.isError || text?.type !== 'text') {
      throw new Error(text?.type === 'text' ? text.text : 'Brand context unavailable.')
    }
    renderContext(JSON.parse(text.text) as BrandContext)
    contextState = 'done'
  } catch (error) {
    if (token !== contextSeq || brand?.domain !== domain) return
    contextState = 'idle'
    contextMessage(error instanceof Error ? error.message : 'Could not load brand context.', true)
  }
}

/* --------------------------------------------------------------------- tabs */

interface TabSpec {
  id: string
  label: string
  available: (data: Brand) => boolean
  count?: (data: Brand) => number
}

function displayableImages(data: Brand): number {
  return (data.images ?? []).filter((i) => (i.formats ?? []).some((f) => f.src)).length
}

const TABS: TabSpec[] = [
  {
    id: 'about',
    label: 'About',
    available: (d) => Boolean(d.description || d.company || (d.links ?? []).length),
  },
  {
    id: 'logos',
    label: 'Logos',
    available: (d) => collectAssets(d.logos ?? []).length > 0,
    count: (d) => collectAssets(d.logos ?? []).length,
  },
  // Count badge on Logos only (design rule, PRD-5043).
  {
    id: 'colors',
    label: 'Colors',
    available: (d) => (d.colors ?? []).length > 0,
  },
  {
    id: 'fonts',
    label: 'Fonts',
    available: (d) => (d.fonts ?? []).some((f) => f.name),
  },
  {
    id: 'images',
    label: 'Images',
    available: (d) => displayableImages(d) > 0,
  },
  { id: 'context', label: 'Brand voice', available: (d) => Boolean(d.domain) },
]

// Tabs size themselves, so switching reports the new height to the host —
// the card shrinks back when leaving a tall tab.
function selectTab(id: string): void {
  for (const [panelId, collapse] of galleryCollapsers) {
    if (panelId !== `panel-${id}`) collapse()
  }
  for (const tabId of availableTabIds) {
    $(`panel-${tabId}`)?.classList.toggle('hidden', tabId !== id)
  }
  for (const btn of tabsEl.querySelectorAll<HTMLButtonElement>('.tab')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === id))
  }
  if (id === 'context') void loadContext()
  scheduleReflow()
}

function renderTabs(data: Brand): void {
  tabsEl.replaceChildren()
  const available = TABS.filter((tab) => tab.available(data))
  availableTabIds = available.map((tab) => tab.id)
  tabsEl.classList.toggle('hidden', available.length < 2)
  for (const tab of available) {
    const btn = el('button', 'tab')
    btn.appendChild(el('span', undefined, tab.label))
    const count = tab.count?.(data) ?? 0
    if (count > 0) btn.appendChild(el('span', 'tab-count', String(count)))
    btn.dataset.tab = tab.id
    btn.setAttribute('role', 'tab')
    btn.onclick = () => selectTab(tab.id)
    tabsEl.appendChild(btn)
  }
}

/* --------------------------------------------------------------------- card */

const BADGE_TOOLTIPS: Record<'claimed' | 'unclaimed', string> = {
  claimed:
    'The brand owner manages this profile, so updates go live the moment they push a change.',
  unclaimed: "This brand hasn't been claimed yet. If you're the owner, click here to claim.",
}

function renderHeader(data: Brand, assets: BrandLogo[]): void {
  const domain = data.domain ?? ''
  $('brand-name').textContent = data.name || domain
  $('brand-domain').textContent = domain

  // Claim state is a seal icon next to the name: blue when claimed, muted
  // when unclaimed; the unclaimed seal deep-links into the register flow
  // to the register flow.
  const badge = $<HTMLButtonElement>('claim-badge')
  const claimed = Boolean(data.claimed)
  badge.classList.toggle('claimed', claimed)
  badge.classList.remove('hidden')
  badge.setAttribute('aria-label', claimed ? 'Claimed brand' : 'Unclaimed brand')
  badge.onclick = claimed
    ? null
    : () => openExternal(`https://brandfetch.com/register?alias=${encodeURIComponent(domain)}`)
  $('badge-tip').textContent = BADGE_TOOLTIPS[claimed ? 'claimed' : 'unclaimed']

  const headerAsset =
    assets.find((a) => a.type === 'icon') ?? assets.find((a) => a.type === 'symbol') ?? assets[0]
  const tile = $('brand-tile')
  if (headerAsset) {
    const formats = headerAsset.formats.filter((f) => f.src)
    $<HTMLImageElement>('brand-logo').src = (
      formats.find((f) => f.format === 'svg') ?? formats[0]
    ).src
    tile.classList.toggle('on-dark', needsDarkTile(headerAsset.type, headerAsset.theme))
    // Icon artwork carries its own baked background: edge to edge, radius
    // clips it.
    tile.classList.toggle('fill', headerAsset.type === 'icon')
    tile.classList.remove('hidden')
  } else {
    tile.classList.add('hidden')
  }

  const viewBtn = $<HTMLButtonElement>('view-bf-btn')
  viewBtn.classList.toggle('hidden', !domain)
  viewBtn.onclick = () => openExternal(`https://brandfetch.com/${domain}`)
}

/* ------------------------------------------------ badge tooltip interaction */

function initBadgeTooltip(): void {
  const badge = $('claim-badge')
  const tip = $('badge-tip')
  const show = () => tip.classList.remove('hidden')
  const hide = () => tip.classList.add('hidden')
  badge.addEventListener('mouseenter', show)
  badge.addEventListener('mouseleave', hide)
  badge.addEventListener('focus', show)
  badge.addEventListener('blur', hide)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide()
  })
}

/** Keep the host's model context pointing at the displayed brand, on first
 * render and on every in-widget switch (PRD-5045 §4). Without this, "that
 * logo" in a follow-up message resolves to the brand of the original tool
 * call — a silent wrong answer. */
let modelContextChain: Promise<void> = Promise.resolve()

function writeModelContext(data: Brand): void {
  if (!app.getHostCapabilities()?.updateModelContext) return
  const name = data.name || data.domain || 'unknown'
  // Writes go out strictly in order (hosts keep the last update received);
  // a payload superseded by a newer committed render is skipped rather than
  // sent late.
  const seq = renderCommitSeq
  modelContextChain = modelContextChain.then(() => {
    if (seq !== renderCommitSeq) return
    return app
      .updateModelContext({
        content: [
          {
            type: 'text',
            text:
              `The Brandfetch brand card is now displaying ${name} ` +
              `(domain: ${data.domain ?? 'unknown'}, id: ${data.id ?? 'unknown'}). ` +
              `References to "this brand" or its assets mean ${name}.`,
          },
        ],
      })
      .then(
        () => {},
        () => {},
      )
  })
}

function renderCard(data: Brand): void {
  selectionSeq++
  renderCommitSeq++
  brand = data
  contextState = 'idle'
  $('panel-context').replaceChildren()
  const assets = collectAssets(data.logos ?? [])

  renderHeader(data, assets)
  renderTabs(data)
  if (assets.length) renderLogos(assets)
  if (data.colors?.length) renderColors(data.colors)
  if (data.fonts?.length) renderFonts(data.fonts)
  if (data.images?.length) renderImages(data.images)
  renderAbout(data)

  // A requested view wins when the brand has that tab; otherwise open on
  // Logos (the card opens on a full logo), else the first available tab.
  const available = TABS.filter((tab) => tab.available(data))
  if (!available.length) {
    showError(`No displayable brand data found for ${data.domain || 'this brand'}.`)
    return
  }
  const viewTab = requestedView ? VIEW_TABS[requestedView] : undefined
  requestedView = undefined
  selectTab(
    (
      available.find((tab) => tab.id === viewTab) ??
      available.find((tab) => tab.id === 'logos') ??
      available[0]
    ).id,
  )

  syncSearch(data)
  writeModelContext(data)

  skeletonEl.classList.add('hidden')
  errorEl.classList.add('hidden')
  cardEl.classList.remove('hidden')
  lastWidth = document.body.getBoundingClientRect().width
  scheduleReflow()
}

/* ------------------------------------------------------------------- search */

// A picker, not a browser (PRD-5045 5.2): five results, no pagination, closes
// on selection. Only rendered when the host supports both the server tools
// this needs and model-context write-back — without write-back, switching
// brands here would silently desync the assistant (§4), so the input hides.
let searchTimer: number | undefined
let searchSeq = 0

function searchAvailable(): boolean {
  const caps = app.getHostCapabilities()
  return Boolean(caps?.serverTools && caps?.updateModelContext)
}

function closeSearchResults(): void {
  const box = $('search-results')
  box.replaceChildren()
  box.classList.add('hidden')
}

function showSearchNote(text: string): void {
  const box = $('search-results')
  box.replaceChildren(el('div', 'search-note', text))
  box.classList.remove('hidden')
}

async function selectSearchResult(result: SearchResult): Promise<void> {
  if (!result.domain) return
  const seq = ++selectionSeq
  showSearchNote(`Loading ${result.name || result.domain}…`)
  try {
    const reply = await app.callServerTool({
      name: 'get_brand',
      arguments: { identifier: result.domain },
    })
    // A newer selection or tool result landed while this one was in flight.
    if (seq !== selectionSeq) return
    const text = reply.content?.find((c) => c.type === 'text')
    if (reply.isError || text?.type !== 'text') throw new Error('Brand lookup failed.')
    closeSearchResults()
    renderCard(JSON.parse(text.text) as Brand)
  } catch {
    if (seq === selectionSeq) showSearchNote('Could not load that brand. Try another result.')
  }
}

function renderSearchResults(results: SearchResult[]): void {
  const box = $('search-results')
  box.replaceChildren()
  for (const result of results.slice(0, 5)) {
    const row = el('button', 'search-result')
    row.setAttribute('role', 'option')
    if (result.icon) {
      const img = el('img')
      img.alt = ''
      img.src = result.icon
      row.appendChild(img)
    }
    row.appendChild(el('span', 'sr-name', result.name || result.domain || ''))
    if (result.domain) row.appendChild(el('span', 'sr-domain', result.domain))
    if (result.claimed) row.appendChild(el('span', 'badge claimed', 'Claimed brand'))
    row.onclick = () => void selectSearchResult(result)
    box.appendChild(row)
  }
  if (!box.childElementCount) box.appendChild(el('div', 'search-note', 'No brands found.'))
  box.classList.remove('hidden')
}

async function runSearch(query: string): Promise<void> {
  const seq = ++searchSeq
  try {
    const reply = await app.callServerTool({ name: 'brand_search', arguments: { query } })
    if (seq !== searchSeq) return
    const text = reply.content?.find((c) => c.type === 'text')
    if (reply.isError || text?.type !== 'text') throw new Error('search failed')
    const parsed = JSON.parse(text.text) as SearchResult[] | { results?: SearchResult[] }
    renderSearchResults(Array.isArray(parsed) ? parsed : (parsed.results ?? []))
  } catch {
    if (seq === searchSeq) showSearchNote('Search unavailable')
  }
}

function initSearch(): void {
  const input = $<HTMLInputElement>('search-input')
  input.addEventListener('input', () => {
    clearTimeout(searchTimer)
    const query = input.value.trim()
    if (query.length < 2) {
      closeSearchResults()
      return
    }
    searchTimer = window.setTimeout(() => void runSearch(query), 300)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSearchResults()
  })
  $<HTMLButtonElement>('search-clear').onclick = () => {
    input.value = ''
    closeSearchResults()
    input.focus()
  }
  document.addEventListener('click', (event) => {
    if (!(event.target as HTMLElement).closest('.search')) closeSearchResults()
  })
}

/** Show the search bar when the host can support it, prefilled with the
 * current brand's domain. */
function syncSearch(data: Brand): void {
  const wrap = $('search')
  if (!searchAvailable()) {
    wrap.classList.add('hidden')
    return
  }
  wrap.classList.remove('hidden')
  $<HTMLInputElement>('search-input').value = data.domain ?? ''
  closeSearchResults()
}

app.ontoolinput = (params) => {
  const view = params.arguments?.view
  if (typeof view === 'string') requestedView = view
}

app.ontoolresult = (result) => {
  if (result.isError) {
    const text = result.content?.find((c) => c.type === 'text')
    showError(text?.type === 'text' ? text.text : 'Brand lookup failed.')
    return
  }
  const text = result.content?.find((c) => c.type === 'text')
  if (text?.type !== 'text') {
    showError('Unexpected tool result: no brand data received.')
    return
  }
  try {
    renderCard(JSON.parse(text.text) as Brand)
  } catch {
    showError('Could not parse brand data.')
  }
}

initSearch()
initBadgeTooltip()
$<HTMLButtonElement>('dev-cta').onclick = () => openExternal('https://brandfetch.com/developers')
$<HTMLButtonElement>('dev-home').onclick = () => openExternal('https://www.brandfetch.com')

app.onhostcontextchanged = applyHostContext

app.connect().then(() => {
  applyHostContext(app.getHostContext())
  reportSize()
})
