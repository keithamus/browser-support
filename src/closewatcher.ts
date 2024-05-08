declare global {
  interface Window {
    CloseWatcher: typeof CloseWatcher
  }
}

const managers = new Map()
class CloseWatcherManager {
  groups: InternalCloseWatcher[][] = []
  allowedNumberOfGroups = 1
  nextUserInteractionAllowsAnewGroup = true

  constructor(window: Window) {
    if (managers.has(window)) return managers.get(window)
    managers.set(window, this)
  }
}

function processCloseWatchers(window: Window) {
  let processedACloseWatcher = false
  const manager = new CloseWatcherManager(window)
  if (manager.groups.length > 0) {
    for (const closeWatcher of (manager.groups.at(-1) || []).reverse()) {
      processedACloseWatcher = true
      if (!closeWatcher.requestClose()) break
    }
  }
  if (manager.allowedNumberOfGroups > 1) manager.allowedNumberOfGroups -= 1
  return processedACloseWatcher
}

// https://whatpr.org/html/10168/interaction.html#close-watcher
class InternalCloseWatcher {
  // https://whatpr.org/html/10168/interaction.html#establish-a-close-watcher
  constructor(
    public cancelAction: () => boolean,
    public closeAction: () => void,
    public window = globalThis.window,
    public isRunningCancelAction = false,
  ) {
    const manager = new CloseWatcherManager(window)
    if (manager.groups.length < manager.allowedNumberOfGroups) {
      manager.groups.push([this])
    } else {
      manager.groups.at(-1)!.push(this)
    }
  }

  get isActive() {
    const manager = new CloseWatcherManager(window)
    for (const group of manager.groups) {
      if (group.includes(this)) return true
    }
    return false
  }

  destroy() {
    const manager = new CloseWatcherManager(window)
    for (const group of manager.groups) {
      if (group.includes(this)) group.splice(group.indexOf(this), 1)
      if (!group.length) {
        manager.groups.splice(manager.groups.indexOf(group), 1)
      }
    }
  }

  // https://whatpr.org/html/10168/interaction.html#close-watcher-close
  close() {
    if (this.isActive && document.defaultView) {
      this.destroy()
      this.closeAction()
    }
  }

  // https://whatpr.org/html/10168/interaction.html#close-watcher-request-close
  requestClose() {
    // Step 5: If window's close watcher manager's groups's size is less than window's close watcher manager's allowed number of groups, and window has history-action activation, then:
    // We cannot easily determine if window has a history-action activation, so we skip this check.
    if (this.isActive && !this.isRunningCancelAction) {
      this.isRunningCancelAction = true
      if (!this.cancelAction()) {
        this.close()
      }
    }
    return true
  }
}

// https://whatpr.org/html/10168/interaction.html#the-closewatcher-interface
class CloseWatcher extends EventTarget {
  get isActive() {
    return this.#internalWatcher.isActive
  }

  #onCancel = null
  get oncancel() {
    return this.#onCancel
  }
  set oncancel(handler) {
    if (this.#onCancel) this.removeEventListener('cancel', this.#onCancel)
    this.#onCancel = null
    if (typeof handler === 'function') this.addEventListener('cancel', (this.#onCancel = handler))
  }

  #onClose = null
  get onclose() {
    return this.#onClose
  }
  set onclose(handler) {
    if (this.#onClose) this.removeEventListener('close', this.#onClose)
    this.#onClose = null
    if (typeof handler === 'function') this.addEventListener('close', (this.#onClose = handler))
  }

  #internalWatcher: InternalCloseWatcher
  constructor({signal}: {signal?: AbortSignal} = {}) {
    super()
    signal?.addEventListener('abort', () => this.destroy())
    this.#internalWatcher = new InternalCloseWatcher(
      () => this.dispatchEvent(new Event('cancel', {cancelable: true})),
      () => this.dispatchEvent(new Event('close')),
    )
  }

  destroy() {
    return this.#internalWatcher.destroy()
  }

  close() {
    return this.#internalWatcher.close()
  }

  requestClose() {
    return this.#internalWatcher.requestClose()
  }
}

function listenForActivationTriggeringInputEvent() {
  const controller = new AbortController()
  const signal = controller.signal
  function notify(e: Event) {
    if (e instanceof KeyboardEvent && e.key === 'Esc') return
    if (e instanceof PointerEvent && e.pointerType === 'mouse') return
    if (e.isTrusted) {
      // https://whatpr.org/html/10168/interaction.html#notify-the-close-watcher-manager-about-user-activation
      const manager = new CloseWatcherManager(window)
      if (manager.nextUserInteractionAllowsAnewGroup) manager.allowedNumberOfGroups += 1
      manager.nextUserInteractionAllowsAnewGroup = false
      controller.abort()
    }
  }
  document.addEventListener('keydown', notify, {signal})
  document.addEventListener('mousedown', notify, {signal})
  document.addEventListener('pointerdown', notify, {signal})
  document.addEventListener('pointerup', notify, {signal})
  document.addEventListener('touchend', notify, {signal, passive: true})
}

export function isSupported(): boolean {
  return typeof globalThis.window.CloseWatcher === 'function'
}

export function isPolyfilled(): boolean {
  return globalThis.window.CloseWatcher === CloseWatcher
}

export function apply(): void {
  if (!isSupported()) {
    globalThis.window.CloseWatcher = CloseWatcher
    listenForActivationTriggeringInputEvent()
    // We can only reasonably polyfill escape keypresses
    document.addEventListener(
      'keyup',
      e => () => {
        if (e.key === 'Esc' && e.target instanceof HTMLElement && e.target.closest('dialog, [popover=auto]')) {
          e.preventDefault()
        }
        setTimeout(() => {
          if (!e.defaultPrevented) processCloseWatchers(window)
        })
      },
      true,
    )
    document.addEventListener(
      'toggle',
      e => {
        if (e.target instanceof HTMLElement && e.target.popover === 'auto') {
          const popover = e.target
          new InternalCloseWatcher(
            () => popover.dispatchEvent(new Event('cancel', {cancelable: true})),
            () => popover.hidePopover(),
          )
        }
      },
      true,
    )
    const originalShowModal = HTMLDialogElement.prototype.showModal
    HTMLDialogElement.prototype.showModal = function (...args) {
      new InternalCloseWatcher(
        () => this.dispatchEvent(new Event('cancel', {cancelable: true})),
        () => this.close(),
      )
      return originalShowModal.apply(this, args)
    }
  }
}
