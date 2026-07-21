<script>
  let { defaults, metadata, errors = {}, onDefault } = $props();
  let capabilities = $derived(metadata?.capabilities ?? {});
  let variants = $derived(optionValues(metadata?.variants, defaults.variant));
  let reasoning = $derived(reasoningValues(metadata?.variants, defaults.reasoningEffort));
  let samplingSupported = $derived(capabilities.temperature !== false);
  let reasoningSupported = $derived(capabilities.reasoning !== false);
  function hasValue(value) { return value !== undefined && value !== null && value !== ''; }

  function optionValues(values, current) {
    const options = values && typeof values === 'object' && !Array.isArray(values) ? Object.keys(values) : [];
    if (current && !options.includes(current)) options.push(current);
    return ['', ...options.sort()];
  }

  function reasoningValues(values, current) {
    const options = new Set(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    if (current) options.add(current);
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      for (const variant of Object.values(values)) if (variant && typeof variant === 'object' && typeof variant.reasoningEffort === 'string') options.add(variant.reasoningEffort);
    }
    return [...options];
  }

  function input(key, event) { onDefault(key, event.currentTarget.value === '' ? undefined : event.currentTarget.value); }

  function thinkingMode(event) {
    const type = event.currentTarget.value;
    const current = defaults.thinking;
    const budgetTokens = typeof current === 'object' && current !== null ? current.budgetTokens : undefined;
    onDefault('thinking', type === '' ? undefined : { type, ...(type === 'enabled' && budgetTokens !== undefined ? { budgetTokens } : {}) });
  }

  function thinkingBudget(event) {
    const current = defaults.thinking;
    onDefault('thinking', { ...(typeof current === 'object' && current !== null ? current : {}), type: 'enabled', budgetTokens: event.currentTarget.value });
  }
</script>

<section class="editor__section" data-section="defaults" aria-labelledby="default-settings-heading">
  <header class="editor__section-header"><h2 class="editor__section-title" id="default-settings-heading">Default generation settings</h2><p class="editor__section-desc">These shared defaults apply only to properties set to Inherit default.</p></header>
  <div class="field-grid">
    <div class="field"><label class="field__label" for="f-variant">Variant</label><select class="field__input" id="f-variant" value={defaults.variant ?? ''} onchange={(event) => input('variant', event)}>{#each variants as variant}<option value={variant}>{variant || '(default)'}</option>{/each}</select>{#if errors.variant}<p class="field__error">{errors.variant}</p>{/if}</div>
    <div class="field"><label class="field__label" for="f-reasoning">Reasoning effort</label><select class="field__input" id="f-reasoning" value={defaults.reasoningEffort ?? ''} disabled={!reasoningSupported && !hasValue(defaults.reasoningEffort)} title={!reasoningSupported ? 'This model does not support reasoning controls.' : ''} onchange={(event) => input('reasoningEffort', event)}>{#each reasoning as effort}<option value={effort}>{effort || '(default)'}</option>{/each}</select>{#if errors.reasoningEffort}<p class="field__error">{errors.reasoningEffort}</p>{/if}</div>
  </div>
  <div class="field-grid field-grid--three">
    <div class="field"><label class="field__label" for="f-temperature">Temperature</label><input class="field__input" class:is-invalid={errors.temperature} type="number" id="f-temperature" step="0.1" min="0" max="2" value={defaults.temperature ?? ''} disabled={!samplingSupported && !hasValue(defaults.temperature)} title={samplingSupported ? '' : 'This model does not support temperature.'} oninput={(event) => input('temperature', event)} />{#if errors.temperature}<p class="field__error">{errors.temperature}</p>{/if}</div>
    <div class="field"><label class="field__label" for="f-top-p">Top-p</label><input class="field__input" class:is-invalid={errors.top_p} type="number" id="f-top-p" step="0.05" min="0" max="1" value={defaults.top_p ?? ''} disabled={!samplingSupported && !hasValue(defaults.top_p)} title={samplingSupported ? '' : 'This model does not support top-p.'} oninput={(event) => input('top_p', event)} />{#if errors.top_p}<p class="field__error">{errors.top_p}</p>{/if}</div>
    <div class="field"><label class="field__label" for="f-max-tokens">Max tokens</label><input class="field__input" class:is-invalid={errors.maxTokens} type="number" id="f-max-tokens" min="1" step="1" value={defaults.maxTokens ?? ''} oninput={(event) => input('maxTokens', event)} />{#if errors.maxTokens}<p class="field__error">{errors.maxTokens}</p>{/if}</div>
  </div>
  <div class="field"><label class="field__label" for="f-thinking-mode">Thinking</label><select class="field__input" id="f-thinking-mode" value={defaults.thinking?.type ?? ''} disabled={!reasoningSupported && !hasValue(defaults.thinking)} title={!reasoningSupported ? 'This model does not support thinking controls.' : ''} onchange={thinkingMode}><option value="">(unset)</option><option value="disabled">Disabled</option><option value="enabled">Enabled</option></select>{#if defaults.thinking?.type === 'enabled'}<input class="field__input" class:is-invalid={errors.budgetTokens} type="number" min="1" step="1" value={defaults.thinking.budgetTokens ?? ''} aria-label="Thinking budget tokens" oninput={thinkingBudget} />{/if}{#if errors.thinking}<p class="field__error">{errors.thinking}</p>{/if}{#if errors.budgetTokens}<p class="field__error">{errors.budgetTokens}</p>{/if}</div>
</section>
