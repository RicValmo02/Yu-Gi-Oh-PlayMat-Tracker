/** Pannello di debug generato da una descrizione dei parametri: slider con valore, salvati in localStorage. */
export interface SliderDef<T> {
  key: keyof T & string;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt?: (v: number) => string;
}

export function buildSliders<T extends object>(
  host: HTMLElement,
  params: T,
  defs: SliderDef<T>[],
  onChange: () => void,
) {
  for (const d of defs) {
    const row = document.createElement("label");
    row.className = "slider";
    const name = document.createElement("span");
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(d.min);
    input.max = String(d.max);
    input.step = String(d.step);
    const value = params[d.key] as number;
    input.value = String(value);
    const fmt = d.fmt ?? ((v: number) => String(v));
    const show = () => (name.textContent = `${d.label}: ${fmt(Number(input.value))}`);
    show();
    input.oninput = () => {
      (params as Record<string, number>)[d.key] = Number(input.value);
      show();
      onChange();
    };
    row.append(name, input);
    host.append(row);
  }
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage non disponibile */
  }
}
