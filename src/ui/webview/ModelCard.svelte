<script>
  let {
    card,
    index,
    defaults,
    metadata,
    errors = {},
    dragActive = false,
    onModel,
    onOverride,
    onRemove,
    onDragStart,
    onDragEnd,
    onKeydown,
  } = $props();


  let isMain = $derived(index === 0);
  let positionLabel = $derived(isMain ? 'MAIN' : `FALLBACK ${index}`);
  let capabilities = $derived(metadata?.capabilities ?? null);
  let samplingSupported = $derived(capabilities?.temperature !== false);
  let reasoningSupported = $derived(capabilities?.reasoning !== false);
  let overrideCount = $derived(Object.values(card.overrides).filter((setting) => setting.mode === 'override').length);
  let variants = $derived(optionValues(metadata?.variants, valueFor('variant')));
  let reasoning = $derived(reasoningValues(metadata?.variants, valueFor('reasoningEffort')));
  let hasAdvancedError = $derived(Boolean(errors.variant || errors.reasoningEffort || errors.temperature || errors.top_p || errors.maxTokens || errors.thinking || errors.budgetTokens));

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

  function valueFor(key) {
    const setting = card.overrides[key];
    return setting.mode === 'override' ? setting.value : defaults[key];
  }

  function displayValue(key) {
    const value = valueFor(key);
    if (value === undefined || value === null || value === '') return '(unset)';
    if (key === 'thinking' && typeof value === 'object') return value.type === 'enabled' ? 'Enabled' : 'Disabled';
    return String(value);
  }

  function isOverride(key) {
    return card.overrides[key].mode === 'override';
  }

  function overrideValue(key, fallback) {
    const value = valueFor(key);
    return value === undefined || value === null ? fallback : value;
  }

  function changeMode(key, event, fallback) {
    onOverride(card.uid, key, event.currentTarget.value === 'inherit'
      ? { mode: 'inherit' }
      : { mode: 'override', value: overrideValue(key, fallback) });
  }

  function changeValue(key, event) {
    onOverride(card.uid, key, { mode: 'override', value: event.currentTarget.value });
  }

  function changeThinkingEnabled(event) {
    const current = overrideValue('thinking', { type: 'disabled' });
    const budgetTokens = typeof current === 'object' && current !== null ? current.budgetTokens : undefined;
    onOverride(card.uid, 'thinking', {
      mode: 'override',
      value: event.currentTarget.checked
        ? { type: 'enabled', ...(budgetTokens === undefined ? {} : { budgetTokens }) }
        : { type: 'disabled' },
    });
  }

  function changeThinkingBudget(event) {
    const current = overrideValue('thinking', { type: 'enabled' });
    onOverride(card.uid, 'thinking', {
      mode: 'override',
      value: { ...(typeof current === 'object' && current !== null ? current : {}), type: 'enabled', budgetTokens: event.currentTarget.value },
    });
  }
</script>

<article class="model-card" class:fallback-card={!isMain} class:model-card--main={isMain} class:model-card--dragging={dragActive}>
  <header class="model-card__header">
    <div class="model-card__heading">
      <button
        type="button"
        class="model-card__handle fallback-card__handle"
        draggable="true"
        title="Drag to reorder. Drop in the first position to replace the Main model."
        aria-label={`Reorder ${isMain ? 'Main model' : `Fallback ${index}`}`}
        aria-describedby="model-drag-instructions"
        aria-grabbed={dragActive}
        aria-keyshortcuts="Space Enter ArrowUp ArrowDown Escape"
        data-model-card-uid={card.uid}
        ondragstart={(event) => onDragStart(event, card.uid)}
        ondragend={onDragEnd}
        onkeydown={(event) => onKeydown(event, card.uid, index)}
      >Drag</button>
      <span class="model-card__position" data-model-position={isMain ? 'main' : `fallback-${index}`}>{positionLabel}</span>
    </div>
    {#if !isMain}
      <button type="button" class="model-card__remove fallback-card__remove" onclick={() => onRemove(card.uid)}>Remove</button>
    {/if}
  </header>

  <div class="field">
    <label class="field__label" for={isMain ? 'f-model' : `fb-model-${card.uid}`}>Model</label>
    <input
      class="field__input field__input--mono"
      class:is-invalid={errors.model}
      type="text"
      id={isMain ? 'f-model' : `fb-model-${card.uid}`}
      list="model-datalist"
      value={card.model}
      placeholder="provider/model-name"
      spellcheck="false"
      autocapitalize="off"
      autocorrect="off"
      data-model-input-uid={card.uid}
      aria-invalid={errors.model ? 'true' : undefined}
      aria-describedby={errors.model ? `model-error-${card.uid}` : undefined}
      oninput={(event) => onModel(card.uid, event.currentTarget.value)}
    />
    {#if errors.model}<p class="field__error" id={`model-error-${card.uid}`}>{errors.model}</p>{/if}
  </div>

  {#if isMain}
    <p class="model-card__note">Main defaults are edited below. Attached fallback override choices travel with this model when the order changes.</p>
  {:else}
    <details class="model-card__advanced">
      <summary class:error={hasAdvancedError}>Advanced: {overrideCount === 0 ? 'All settings inherited' : `${overrideCount} override${overrideCount === 1 ? '' : 's'}`}{#if hasAdvancedError}<span class="model-card__error-marker">Needs attention</span>{/if}</summary>
      <div class="model-card__advanced-body">
        <div class="field-grid">
          <div class="field">
            <label class="field__label" for={`variant-mode-${card.uid}`}>Variant</label>
            <select class="field__input" id={`variant-mode-${card.uid}`} name="variant-mode" value={isOverride('variant') ? 'override' : 'inherit'} onchange={(event) => changeMode('variant', event, '')}>
              <option value="inherit">Inherit default</option><option value="override">Override</option>
            </select>
            {#if isOverride('variant')}
              <select class="field__input" value={String(overrideValue('variant', ''))} onchange={(event) => changeValue('variant', event)}>
                {#each variants as variant}<option value={variant}>{variant || '(default)'}</option>{/each}
              </select>
            {:else}<input class="field__input" value={displayValue('variant')} disabled />{/if}
            {#if errors.variant}<p class="field__error">{errors.variant}</p>{/if}
          </div>
          <div class="field">
            <label class="field__label" for={`reasoning-mode-${card.uid}`}>Reasoning effort</label>
            <select class="field__input" id={`reasoning-mode-${card.uid}`} name="reasoningEffort-mode" value={isOverride('reasoningEffort') ? 'override' : 'inherit'} onchange={(event) => changeMode('reasoningEffort', event, '')}>
              <option value="inherit">Inherit default</option><option value="override">Override</option>
            </select>
            {#if isOverride('reasoningEffort')}
              <select class="field__input" value={String(overrideValue('reasoningEffort', ''))} disabled={!reasoningSupported} onchange={(event) => changeValue('reasoningEffort', event)}>
                {#each reasoning as reasoning}<option value={reasoning}>{reasoning || '(default)'}</option>{/each}
              </select>
            {:else}<input class="field__input" value={displayValue('reasoningEffort')} disabled />{/if}
            {#if errors.reasoningEffort}<p class="field__error">{errors.reasoningEffort}</p>{/if}
          </div>
        </div>

        <div class="field-grid field-grid--three">
          {#each [['temperature', 'Temperature', '0.1', '0', '2'], ['top_p', 'Top-p', '0.05', '0', '1'], ['maxTokens', 'Max tokens', '1', '1', undefined]] as setting}
            <div class="field">
              <label class="field__label" for={`${setting[0]}-mode-${card.uid}`}>{setting[1]}</label>
              <select class="field__input" id={`${setting[0]}-mode-${card.uid}`} name={`${setting[0]}-mode`} value={isOverride(setting[0]) ? 'override' : 'inherit'} onchange={(event) => changeMode(setting[0], event, '')}>
                <option value="inherit">Inherit default</option><option value="override">Override</option>
              </select>
              {#if isOverride(setting[0])}
                <input class="field__input" class:is-invalid={errors[setting[0]]} type="number" value={String(overrideValue(setting[0], ''))} step={setting[2]} min={setting[3]} max={setting[4]} disabled={setting[0] !== 'maxTokens' && !samplingSupported} aria-invalid={errors[setting[0]] ? 'true' : undefined} oninput={(event) => changeValue(setting[0], event)} />
              {:else}<input class="field__input" value={displayValue(setting[0])} disabled />{/if}
              {#if errors[setting[0]]}<p class="field__error">{errors[setting[0]]}</p>{/if}
            </div>
          {/each}
        </div>
        {#if !samplingSupported && (isOverride('temperature') || isOverride('top_p'))}<p class="field__error">This model does not support sampling controls.</p>{/if}

        <div class="field">
          <label class="field__label" for={`thinking-mode-${card.uid}`}>Thinking</label>
          <select class="field__input" id={`thinking-mode-${card.uid}`} name="thinking-mode" value={isOverride('thinking') ? 'override' : 'inherit'} onchange={(event) => changeMode('thinking', event, { type: 'disabled' })}>
            <option value="inherit">Inherit default</option><option value="override">Override</option>
          </select>
          {#if isOverride('thinking')}
            {@const thinking = overrideValue('thinking', { type: 'disabled' })}
            <label class="field__checkbox-row"><input class="field__checkbox" type="checkbox" checked={typeof thinking === 'object' && thinking !== null && thinking.type === 'enabled'} disabled={!reasoningSupported} onchange={changeThinkingEnabled} /> Enable thinking</label>
            {#if typeof thinking === 'object' && thinking !== null && thinking.type === 'enabled'}
              <input class="field__input" class:is-invalid={errors.budgetTokens} type="number" value={thinking.budgetTokens ?? ''} min="1" step="1" disabled={!reasoningSupported} aria-label="Thinking budget tokens" oninput={changeThinkingBudget} />
            {/if}
          {:else}<input class="field__input" value={displayValue('thinking')} disabled />{/if}
          {#if errors.thinking}<p class="field__error">{errors.thinking}</p>{/if}
          {#if errors.budgetTokens}<p class="field__error">{errors.budgetTokens}</p>{/if}
          {#if !reasoningSupported && isOverride('thinking')}<p class="field__error">This model does not support thinking controls.</p>{/if}
        </div>
      </div>
    </details>
  {/if}
</article>
