function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function effectiveValue(card, defaults, key) {
  const override = card.overrides[key];
  return override.mode === 'override' ? override.value : defaults[key];
}

function addError(errors, uid, field, message) {
  errors[uid] ??= {};
  errors[uid][field] = message;
}

export function validateModelCapabilities(routing, metadataByModel) {
  const errors = {};
  for (const card of routing.cards) {
    const metadata = metadataByModel[card.model];
    if (!metadata) continue;
    const capabilities = metadata.capabilities ?? {};
    const temperatureOverride = card.overrides.temperature;
    const topPOverride = card.overrides.top_p;
    const reasoning = effectiveValue(card, routing.defaults, 'reasoning');
    const thinking = effectiveValue(card, routing.defaults, 'thinking');
    if (capabilities.temperature === false) {
      if (temperatureOverride.mode === 'override' && hasValue(temperatureOverride.value)) addError(errors, card.uid, 'temperature', 'This model does not support temperature.');
      if (topPOverride.mode === 'override' && hasValue(topPOverride.value)) addError(errors, card.uid, 'top_p', 'This model does not support top-p.');
    }
    if (capabilities.reasoning === false) {
      if (hasValue(reasoning)) addError(errors, card.uid, 'reasoning', 'This model does not support reasoning controls.');
      if (hasValue(thinking)) addError(errors, card.uid, 'thinking', 'This model does not support thinking controls.');
    }
  }
  return errors;
}

export function mergeValidationErrors(...groups) {
  return groups.reduce((merged, group) => {
    for (const [uid, fields] of Object.entries(group)) merged[uid] = { ...merged[uid], ...fields };
    return merged;
  }, {});
}
