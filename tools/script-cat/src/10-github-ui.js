  // ───────────────────────────── GitHub ─────────────────────────────
  function githubDialog() {
    connectionDialog({ focusGithub: true });
  }

  /** Один раз после ложного отказа сами показываем, где взять токен. */
  function maybeGhDialog() {
    if (!GM_getValue(K.ghAsk, 0)) return;
    GM_setValue(K.ghAsk, 0);
    setTimeout(() => githubDialog(), 400);
  }
