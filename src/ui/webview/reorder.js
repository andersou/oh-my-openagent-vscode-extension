function isValidIndex(index, length) {
  return Number.isInteger(index) && index >= 0 && index < length;
}

export function moveItem(arr, from, to) {
  if (!Array.isArray(arr)) return arr;
  if (!isValidIndex(from, arr.length) || !isValidIndex(to, arr.length) || from === to) {
    return [...arr];
  }

  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
