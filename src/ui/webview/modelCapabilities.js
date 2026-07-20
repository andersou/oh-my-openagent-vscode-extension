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
    const temperature = effectiveValue(card, routing.defaults, 'temperature');
    const topP = effectiveValue(card, routing.defaults, 'top_p');
    const reasoning = effectiveValue(card, routing.defaults, 'reasoningEffort');
    const thinking = effectiveValue(card, routing.defaults, 'thinking');
    const variant = effectiveValue(card, routing.defaults, 'variant');
    if (capabilities.temperature === false) {
      if (hasValue(temperature)) addError(errors, card.uid, 'temperature', 'This model does not support temperature.');
      if (hasValue(topP)) addError(errors, card.uid, 'top_p', 'This model does not support top-p.');
    }
    if (capabilities.reasoning === false) {
      if (hasValue(reasoning)) addError(errors, card.uid, 'reasoningEffort', 'This model does not support reasoning controls.');
      if (hasValue(thinking)) addError(errors, card.uid, 'thinking', 'This model does not support thinking controls.');
    }
    const variants = metadata.variants;
    if (hasValue(variant) && variants && typeof variants === 'object' && !Array.isArray(variants) && Object.keys(variants).length > 0 && !Object.hasOwn(variants, variant)) {
      addError(errors, card.uid, 'variant', 'This model does not offer the selected variant.');
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
