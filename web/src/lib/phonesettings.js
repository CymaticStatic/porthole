// The "Phone settings" group on the Settings page: two buttons that open native screens of the Android app.
// The page only offers them inside the app (the bridge is present); a plain browser has nothing to open.

/** @typedef {{screen: "machines" | "battery", label: string, test: string}} PhoneSettingsLink */

/**
 * The buttons to show, or an empty list when the page is not running inside the app.
 * @param {{available?: boolean} | null | undefined} bridge
 * @param {{phoneMachines: string, phoneKeepRunning: string}} copy
 * @returns {PhoneSettingsLink[]}
 */
export function phoneSettingsLinks(bridge, copy) {
  if (!bridge?.available) return [];
  return [
    { screen: "machines", label: copy.phoneMachines, test: "phone-settings-machines" },
    { screen: "battery", label: copy.phoneKeepRunning, test: "phone-settings-battery" },
  ];
}
