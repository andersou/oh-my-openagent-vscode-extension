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

  const ADVANCED_SETTINGS = ['reasoning', 'temperature', 'top_p', 'maxTokens', 'thinking'];

  let isMain = $derived(index === 0);
  let positionLabel = $derived(isMain ? 'MAIN' : `FALLBACK ${index}`);
  let capabilities = $derived(metadata?.capabilities ?? null);
  let samplingSupported = $derived(capabilities?.temperature !== false);
  let reasoningSupported = $derived(capabilities?.reasoning !== false);
  let overrideCount = $derived(ADVANCED_SETTINGS.filter((key) => card.overrides[key].mode === 'override').length);
  let reasoningOptions = $derived(reasoningValues(valueFor('reasoning')));
  let hasAdvancedError = $derived(Boolean(errors.reasoning || errors.temperature || errors.top_p || errors.maxTokens || errors.thinking || errors.budgetTokens));

  function reasoningValues(current) {
    const options = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'];
    if (current && !options.includes(String(current))) options.push(String(current));
    return options;
  }

  function valueFor(key) {
    const setting = card.overrides[key];
    return setting.mode === 'override' ? setting.value : defaults[key];
  }

  function inheritedValueLabel(key) {
    const value = defaults[key];
    if (value === undefined || value === null || value === '') return 'unset';
    if (key === 'thinking' && typeof value === 'object') return value.type === 'enabled' ? 'Enabled' : 'Disabled';
    return String(value);
  }

  function isOverride(key) {
    return card.overrides[key].mode === 'override';
  }

  function overrideValue(key, fallback) {
    const setting = card.overrides[key];
    return setting.mode === 'override' ? setting.value : fallback;
  }

  function inheritLabel(key) {
    return `Inherit (${inheritedValueLabel(key)})`;
  }

  function inheritedPlaceholder(key) {
    const value = inheritedValueLabel(key);
    return value === 'unset' ? 'Unset' : value;
  }

  function changeScalarOverride(key, event) {
    const value = event.currentTarget.value;
    onOverride(card.uid, key, value === ''
      ? { mode: 'inherit' }
      : { mode: 'override', value });
  }

  function changeThinkingMode(event) {
    const type = event.currentTarget.value;
    if (type === '') {
      onOverride(card.uid, 'thinking', { mode: 'inherit' });
      return;
    }
    const current = overrideValue('thinking', defaults.thinking ?? {});
    const budgetTokens = typeof current === 'object' && current !== null ? current.budgetTokens : undefined;
    onOverride(card.uid, 'thinking', {
      mode: 'override',
      value: {
        type,
        ...(type === 'enabled' && budgetTokens !== undefined ? { budgetTokens } : {}),
      },
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
      <span class="model-card__position" class:model-card__position--main={isMain} data-model-position={isMain ? 'main' : `fallback-${index}`}>{positionLabel}</span>
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

  <details class="model-card__advanced">
    <summary class:error={hasAdvancedError}>Advanced: {overrideCount === 0 ? 'All settings inherited' : `${overrideCount} override${overrideCount === 1 ? '' : 's'}`}{#if hasAdvancedError}<span class="model-card__error-marker">Needs attention</span>{/if}</summary>
    <div class="model-card__advanced-body">
      <div class="field-grid">
        <div class="field">
          <label class="field__label" for={`reasoning-override-${card.uid}`}>Reasoning effort</label>
          <select
            class="field__input"
            id={`reasoning-override-${card.uid}`}
            name="reasoning-override"
            value={isOverride('reasoning') ? String(overrideValue('reasoning', '')) : ''}
            disabled={!reasoningSupported && !isOverride('reasoning')}
            title={!reasoningSupported ? 'This model does not support reasoning controls.' : ''}
            onchange={(event) => changeScalarOverride('reasoning', event)}
          >
            <option value="">{inheritLabel('reasoning')}</option>
            {#each reasoningOptions as option}<option value={option}>{option}</option>{/each}
          </select>
          {#if errors.reasoning}<p class="field__error">{errors.reasoning}</p>{/if}
        </div>

        <div class="field">
          <label class="field__label" for={`thinking-override-${card.uid}`}>Thinking</label>
          <select
            class="field__input"
            id={`thinking-override-${card.uid}`}
            name="thinking-override"
            value={isOverride('thinking') ? String(overrideValue('thinking', { type: 'disabled' }).type) : ''}
            disabled={!reasoningSupported && !isOverride('thinking')}
            title={!reasoningSupported ? 'This model does not support thinking controls.' : ''}
            onchange={changeThinkingMode}
          >
            <option value="">{inheritLabel('thinking')}</option>
            <option value="disabled">Disabled</option>
            <option value="enabled">Enabled</option>
          </select>
          {#if isOverride('thinking')}
            {@const thinking = overrideValue('thinking', { type: 'disabled' })}
            {#if typeof thinking === 'object' && thinking !== null && thinking.type === 'enabled'}
              <input class="field__input" class:is-invalid={errors.budgetTokens} type="number" value={thinking.budgetTokens ?? ''} min="1" step="1" disabled={!reasoningSupported} placeholder="Budget tokens" aria-label="Thinking budget tokens" oninput={changeThinkingBudget} />
            {/if}
          {/if}
          {#if errors.thinking}<p class="field__error">{errors.thinking}</p>{/if}
          {#if errors.budgetTokens}<p class="field__error">{errors.budgetTokens}</p>{/if}
        </div>
      </div>

      <div class="field-grid field-grid--three">
        {#each [['temperature', 'Temperature', '0.1', '0', '2'], ['top_p', 'Top-p', '0.05', '0', '1'], ['maxTokens', 'Max tokens', '1', '1', undefined]] as setting}
          <div class="field">
            <label class="field__label" for={`${setting[0]}-override-${card.uid}`}>{setting[1]}</label>
            <input
              class="field__input"
              class:is-invalid={errors[setting[0]]}
              type="number"
              id={`${setting[0]}-override-${card.uid}`}
              name={`${setting[0]}-override`}
              value={isOverride(setting[0]) ? String(overrideValue(setting[0], '')) : ''}
              placeholder={inheritedPlaceholder(setting[0])}
              step={setting[2]}
              min={setting[3]}
              max={setting[4]}
              disabled={setting[0] !== 'maxTokens' && !samplingSupported && !isOverride(setting[0])}
              title={setting[0] !== 'maxTokens' && !samplingSupported ? 'This model does not support sampling controls.' : ''}
              aria-invalid={errors[setting[0]] ? 'true' : undefined}
              oninput={(event) => changeScalarOverride(setting[0], event)}
            />
            {#if errors[setting[0]]}<p class="field__error">{errors[setting[0]]}</p>{/if}
          </div>
        {/each}
      </div>
      {#if !samplingSupported && (isOverride('temperature') || isOverride('top_p'))}<p class="field__error">This model does not support sampling controls.</p>{/if}
    </div>
  </details>
</article>
