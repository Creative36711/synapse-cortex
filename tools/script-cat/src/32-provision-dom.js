  // ───────────────────────── provisioning: DOM Arena ─────────────────────────
  // Селекторы не используют radix-* id и nth-child. Неоднозначность — ошибка,
  // а не выбор «первого подходящего». Add repositories и Archive нового агента
  // не нажимаются. Rename/Archive работают только через видимые пункты меню.

  const PROVISION_SEL = Object.freeze({
    repoTrigger: 'main button[aria-haspopup="dialog"][aria-controls]',
    picker: '[data-radix-popper-content-wrapper] [role="dialog"][data-state="open"] [cmdk-root]',
    pickerInput: '[cmdk-input][role="combobox"]',
    pickerList: '[cmdk-list][role="listbox"]',
    pickerItem: '[cmdk-item][role="option"]',
    sidebarRoot: '[data-sidebar="sidebar"], [data-slot="sidebar"]',
    sidebarItem: 'a[data-sidebar="menu-button"][href]',
    menuAction: 'button[data-sidebar="menu-action"][aria-haspopup="menu"]',
    openMenu: '[role="menu"][data-state="open"]',
    menuItem: '[role="menuitem"]',
    dialog: '[role="dialog"][data-state="open"]',
    renameInput: 'input[maxlength="100"]',
  });
  const PROVISION_EXCLUDE = '#cfn-panel, [id^="cfn-"], [data-sidebar="sidebar"], [data-slot="sidebar"], aside, nav';

  class ProvisionDomError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
  }
  const provisionDomFail = (code, message) => { throw new ProvisionDomError(code, message); };
  const provisionAll = (root, selector) => [...(root || document).querySelectorAll(selector)];
  const provisionVisible = (root, selector) => provisionAll(root, selector).filter((el) => visible(el));
  function provisionOne(root, selector, code) {
    const found = provisionVisible(root, selector);
    if (found.length !== 1) provisionDomFail(code, `${selector}: найдено ${found.length}, ожидался 1`);
    return found[0];
  }
  const provisionText = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();

  function provisionAgentUuid(value) {
    try {
      const url = new URL(String(value || ""), location.origin);
      if (url.origin !== location.origin) return "";
      const m = url.pathname.match(/^\/agent\/([0-9a-f-]{36})\/?$/i);
      return m && PROVISION_UUID.test(m[1]) ? m[1].toLowerCase() : "";
    } catch { return ""; }
  }
  const provisionCurrentAgentUuid = () => provisionAgentUuid(location.pathname + location.search + location.hash);

  async function provisionWait(check, timeoutMs, stepMs = 300) {
    const until = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() >= until) return null;
      await sleep(stepMs);
    }
  }
  function provisionSetInput(el, value) {
    const proto = typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function provisionRepoTriggers() {
    const main = document.querySelector("main") || document;
    return provisionVisible(main, PROVISION_SEL.repoTrigger).filter((el) => {
      if (el.closest(PROVISION_EXCLUDE)) return false;
      const spans = provisionAll(el, "span").map((s) => normalizeProvisionRepo(provisionText(s))).filter(Boolean);
      return spans.length > 0 || /select a repository/i.test(provisionText(el));
    });
  }
  function provisionTriggerRepo(trigger) {
    for (const span of provisionAll(trigger, "span")) {
      const repo = normalizeProvisionRepo(provisionText(span));
      if (repo) return repo;
    }
    return "";
  }
  function provisionPicker() {
    const found = provisionVisible(document, PROVISION_SEL.picker);
    if (found.length > 1) provisionDomFail("provision_picker_ambiguous", "открыто несколько repo picker");
    return found[0] || null;
  }
  function provisionRepoOption(picker, repo) {
    const list = provisionOne(picker, PROVISION_SEL.pickerList, "provision_picker_list_missing");
    const items = provisionVisible(list, PROVISION_SEL.pickerItem).filter((item) => {
      const dv = normalizeProvisionRepo(item.getAttribute("data-value"));
      if (dv && dv !== repo) return false;
      return provisionAll(item, "span").some((s) => normalizeProvisionRepo(provisionText(s)) === repo);
    });
    if (items.length !== 1) provisionDomFail("provision_repo_option_missing", `repo ${repo}: options ${items.length}`);
    return items[0];
  }
  function provisionComposerReady() {
    const editor = typeof composer === "function" ? composer() : null;
    if (!editor) return false;
    return typeof sendButton === "function" ? Boolean(sendButton(editor)) : true;
  }

  /** Выбирает repo в composer. Уже выбранный repo не кликается повторно. */
  async function provisionSelectRepository(repo, cfg = provisionConfig()) {
    const target = normalizeProvisionRepo(repo);
    if (!target) provisionDomFail("provision_repo_invalid", "repo не нормализуется");
    const triggers = provisionRepoTriggers();
    if (triggers.length !== 1) provisionDomFail("provision_repo_trigger_ambiguous", `repo triggers: ${triggers.length}`);
    const trigger = triggers[0];
    if (provisionTriggerRepo(trigger) === target) return { alreadySelected: true, attempts: 0 };
    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      trigger.click();
      const picker = await provisionWait(() => provisionPicker(), 5000);
      if (!picker) continue;
      const input = provisionOne(picker, PROVISION_SEL.pickerInput, "provision_picker_input_missing");
      provisionSetInput(input, target);
      const option = await provisionWait(() => {
        try { return provisionRepoOption(picker, target); } catch { return null; }
      }, 5000);
      if (!option) continue;
      option.click();
      const closed = await provisionWait(() => !provisionPicker(), 5000);
      const updated = await provisionWait(() => provisionTriggerRepo(trigger) === target, 5000);
      const ready = await provisionWait(provisionComposerReady, 8000);
      if (closed && updated && ready) return { alreadySelected: false, attempts };
    }
    provisionDomFail("provision_repo_select_failed", `repo ${target} не выбран за ${attempts} попытки`);
  }

  function provisionSidebarRoot() {
    const roots = provisionVisible(document, PROVISION_SEL.sidebarRoot);
    if (roots.length !== 1) provisionDomFail("provision_sidebar_ambiguous", `sidebar roots: ${roots.length}`);
    return roots[0];
  }
  function provisionSidebarItems(root = provisionSidebarRoot()) {
    return provisionAll(root, PROVISION_SEL.sidebarItem).map((item) => ({
      item, uuid: provisionAgentUuid(item.getAttribute("href")),
    })).filter((x) => x.uuid);
  }
  function provisionFindSidebarItem(agentUuid) {
    const id = String(agentUuid || "").toLowerCase();
    return provisionSidebarItems().find((x) => x.uuid === id)?.item || null;
  }
  async function provisionWaitSidebarItem(agentUuid, timeoutMs = 8000) {
    return provisionWait(() => provisionFindSidebarItem(agentUuid), timeoutMs);
  }
  function provisionMenuItemContainer(item) {
    return item.closest('[data-sidebar="menu-item"]') || item.parentElement || item;
  }
  async function provisionOpenItemMenu(item) {
    const holder = provisionMenuItemContainer(item);
    const action = provisionOne(holder, PROVISION_SEL.menuAction, "provision_menu_action_missing");
    action.click();
    const menu = await provisionWait(() => {
      const found = provisionVisible(document, PROVISION_SEL.openMenu);
      return found.length === 1 ? found[0] : null;
    }, 5000);
    if (!menu) provisionDomFail("provision_menu_missing", "More options меню не открылось");
    return menu;
  }
  function provisionMenuButton(menu, label) {
    const wanted = String(label).toLowerCase();
    const found = provisionVisible(menu, PROVISION_SEL.menuItem).filter((el) => provisionText(el).toLowerCase() === wanted);
    if (found.length !== 1) provisionDomFail("provision_menu_item_missing", `${label}: найдено ${found.length}`);
    return found[0];
  }
  function provisionRenameDialog() {
    const dialogs = provisionVisible(document, PROVISION_SEL.dialog).filter((d) =>
      /rename chat/i.test(provisionText(d)) && provisionAll(d, PROVISION_SEL.renameInput).length === 1);
    if (dialogs.length !== 1) provisionDomFail("provision_rename_dialog_missing", `Rename chat dialogs: ${dialogs.length}`);
    return dialogs[0];
  }
  function provisionRenameSubmit(dialog) {
    const found = provisionVisible(dialog, 'button[type="submit"]').filter((b) => /^rename$/i.test(provisionText(b)));
    if (found.length !== 1) provisionDomFail("provision_rename_submit_missing", `Rename submit: ${found.length}`);
    return found[0];
  }
  const provisionEnabled = (el) => Boolean(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && el.getAttribute("data-disabled") !== "true";

  /** Rename сессии в имя роли. Тост не является условием успеха. */
  async function provisionRenameAgent(agentUuid, roleName, cfg = provisionConfig()) {
    const name = String(roleName || "").trim();
    if (!name || name.length > 100) provisionDomFail("provision_rename_name_invalid", "имя роли пустое или >100");
    let attempts = 0;
    while (attempts < cfg.agentRenameAttempts) {
      attempts += 1;
      const item = provisionFindSidebarItem(agentUuid);
      if (!item) provisionDomFail("provision_sidebar_item_missing", "sidebar item для rename не найден");
      const menu = await provisionOpenItemMenu(item);
      provisionMenuButton(menu, "Rename").click();
      const dialog = await provisionWait(() => {
        try { return provisionRenameDialog(); } catch { return null; }
      }, 5000);
      if (!dialog) continue;
      const input = provisionOne(dialog, PROVISION_SEL.renameInput, "provision_rename_input_missing");
      provisionSetInput(input, name);
      const submit = await provisionWait(() => {
        const button = provisionRenameSubmit(dialog);
        return provisionEnabled(button) ? button : null;
      }, 5000);
      if (!submit) continue;
      submit.click();
      const closed = await provisionWait(() => {
        try { provisionRenameDialog(); return false; } catch { return true; }
      }, 5000);
      const renamed = await provisionWait(() => {
        const live = provisionFindSidebarItem(agentUuid);
        return live && provisionText(live) === name ? live : null;
      }, 8000);
      if (closed && renamed) return { attempts };
    }
    provisionDomFail("provision_rename_failed", `rename не подтверждён за ${attempts} попытки`);
  }

  /**
   * Архив старого агента. Возвращает unverified, если пункт не найден или
   * исчезновение не подтвердилось; это не откатывает успешную замену.
   */
  async function provisionArchiveAgent(agentUuid, timeoutMs = 8000) {
    const item = provisionFindSidebarItem(agentUuid);
    if (!item) return { archived: false, unverified: true, reason: "sidebar item не найден" };
    let menu;
    try { menu = await provisionOpenItemMenu(item); }
    catch (error) { return { archived: false, unverified: true, reason: error.message }; }
    let archive;
    try { archive = provisionMenuButton(menu, "Archive"); }
    catch (error) { return { archived: false, unverified: true, reason: error.message }; }
    archive.click();
    const gone = await provisionWait(() => !provisionFindSidebarItem(agentUuid), timeoutMs);
    if (gone) return { archived: true, unverified: false };
    return { archived: false, unverified: true, reason: "признак архивации не подтверждён" };
  }
