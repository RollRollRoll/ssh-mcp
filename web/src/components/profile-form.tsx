import { useMemo, useState } from "react";
import type { ConsoleHost, ConsoleProfile, ConsoleProfileParameter } from "../console-types";

export function ProfileForm({
  hosts, profiles, disabled, busy, onChange, onPreview
}: {
  readonly hosts: readonly ConsoleHost[];
  readonly profiles: readonly ConsoleProfile[];
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onChange: () => void;
  readonly onPreview: (input: {
    readonly host: string;
    readonly profileId: string;
    readonly parameters: Readonly<Record<string, string | number | boolean>>;
  }) => void;
}) {
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const profile = profiles.find((item) => item.id === profileId) ?? profiles[0];
  const availableHosts = useMemo(() => hosts.filter((host) => profile?.hostAliases.includes(host.alias)
    && profile.platform === host.platform), [hosts, profile]);
  const [host, setHost] = useState("");
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const selectedHost = availableHosts.some((item) => item.alias === host) ? host : (availableHosts[0]?.alias ?? "");

  const changeParameter = (parameter: ConsoleProfileParameter, value: string | boolean): void => {
    setValues((current) => ({
      ...current,
      [parameter.name]: parameter.type === "integer" && typeof value === "string"
        ? (value === "" ? value : Number(value)) : value
    }));
    onChange();
  };

  return (
    <form className="action-form" onSubmit={(event) => {
      event.preventDefault();
      const parameters = Object.fromEntries((profile?.parameters ?? []).flatMap((parameter) => {
        const value = values[parameter.name];
        if (value !== undefined && value !== "") return [[parameter.name, value]];
        return parameter.type === "boolean" && parameter.required ? [[parameter.name, false]] : [];
      }));
      onPreview({ host: selectedHost, profileId: profile?.id ?? "", parameters });
    }}>
      <label>低风险 Profile
        <select value={profile?.id ?? ""} disabled={disabled || profiles.length === 0} onChange={(event) => {
          setProfileId(event.target.value); setHost(""); setValues({}); onChange();
        }}>
          {profiles.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.platform}</option>)}
        </select>
      </label>
      <label>目标主机
        <select value={selectedHost} disabled={disabled || availableHosts.length === 0}
          onChange={(event) => { setHost(event.target.value); onChange(); }}>
          {availableHosts.map((item) => <option key={item.alias} value={item.alias}>{item.alias}</option>)}
        </select>
      </label>
      {profile?.parameters.map((parameter) => (
        <ParameterField key={parameter.name} parameter={parameter} value={values[parameter.name]}
          disabled={disabled} onChange={(value) => changeParameter(parameter, value)} />
      ))}
      <button type="submit" disabled={disabled || busy || profile === undefined || selectedHost.length === 0}>生成确认预览</button>
    </form>
  );
}

function ParameterField({ parameter, value, disabled, onChange }: {
  readonly parameter: ConsoleProfileParameter;
  readonly value: string | number | boolean | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string | boolean) => void;
}) {
  if (parameter.type === "boolean") {
    return <label className="checkbox-field"><input type="checkbox" checked={value === true} disabled={disabled}
      onChange={(event) => onChange(event.target.checked)} />{parameter.name}</label>;
  }
  if (parameter.type === "enum") {
    return <label>{parameter.name}<select value={String(value ?? "")} disabled={disabled} required={parameter.required}
      onChange={(event) => onChange(event.target.value)}>
      <option value="">请选择</option>
      {parameter.values.map((item) => <option key={item} value={item}>{item}</option>)}
    </select></label>;
  }
  return <label>{parameter.name}<input
    type={parameter.type === "integer" ? "number" : "text"}
    value={String(value ?? "")}
    disabled={disabled}
    required={parameter.required}
    {...(parameter.type === "integer" ? { min: parameter.minimum, max: parameter.maximum, step: 1 } : {})}
    onChange={(event) => onChange(event.target.value)}
  /></label>;
}
