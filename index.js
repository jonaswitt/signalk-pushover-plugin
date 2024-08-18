/**
 * @typedef {import('@signalk/server-api').ServerAPI} ServerAPI
 * @typedef {import('@signalk/server-api').Plugin} Plugin
 */

module.exports = (
    /** @type {ServerAPI} */
    app
) => {
    let unsubscribes = [];

    const lastValues = {};
    const getLastValue = (key, maxAgeSec = undefined) => {
        if (lastValues[key]?.value == null) {
            return lastValues[key]?.value;
        }
        if (maxAgeSec != null && Date.now() > lastValues[key].timestamp.valueOf() + maxAgeSec * 1000) {
            return undefined;
        }
        return lastValues[key]?.value;
    }
    const getLastValueAsNumber = (key, maxAgeSec = undefined) => {
        const value = getLastValue(key, maxAgeSec);
        return value != null && !Number.isNaN(value) ? Number(value) : value;
    };
    const setLastValue = (key, value) => {
        lastValues[key] = {
            value: value ?? null,
            timestamp: new Date(),
        };
    }

    let anchorStatusTimeout;
    let anchorStatusInterval;
    let positionUpdateTimeout;

    const getStatusText = () => {
        const currentRadius = getLastValueAsNumber("navigation.anchor.currentRadius", 60);
        const maxRadius = getLastValueAsNumber("navigation.anchor.maxRadius", undefined);
        const bearingTrue = getLastValueAsNumber("navigation.anchor.bearingTrue", 60);
        const depthBelowSurface = getLastValueAsNumber("environment.depth.belowSurface", 60);

        return `${currentRadius?.toFixed(0) ?? '?'}/${maxRadius?.toFixed(0) ?? '?'} m @ ${bearingTrue != null ? (bearingTrue * 180 / Math.PI).toFixed(0) : '?'} deg${depthBelowSurface != null ? `, depth ${depthBelowSurface?.toFixed(1) ?? '?'} m` : ''}`
    };

    /** @type {Plugin} */
    const plugin = {
        id: "signalk-pushover-plugin",
        name: "Anchor Alarm (Pushover push notifications)",
        start: (settings, restartPlugin) => {
            const sendPush = async (options = {}) => {
                const res = await fetch('https://api.pushover.net/1/messages.json', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: new URLSearchParams({
                        token: 'a5q57vtxjqzz56qo6gnnbmj6omyip7',
                        user: settings.pushover_user,
                        title: 'Anchor Alarm',
                        ...options,
                    }).toString()
                });
                if (!res.ok) {
                    app.error(`Failed to send push notification ${JSON.stringify(options)}: HTTP ${res.status} ${res.statusText}`);
                } else {
                    const resBody = await res.json();
                    app.debug(`Push notification ${JSON.stringify(options)} sent: ${JSON.stringify(resBody)}`);
                }
            }

            const setPositionUpdateTimeout = () => {
                if (positionUpdateTimeout != null) {
                    clearTimeout(positionUpdateTimeout);
                }
                if (getLastValue("navigation.anchor.maxRadius", undefined) == null // Anchor not set
                    || !settings.no_position_alert_interval) {
                    return;
                }
                positionUpdateTimeout = setTimeout(() => {
                    sendPush({
                        message: `NO GPS ${getStatusText()}`,
                        priority: 2,
                        retry: 30,
                        expire: 600,
                    });
                }, settings.no_position_alert_interval * 1000);
            }
            setPositionUpdateTimeout();

            if (settings.anchor_ok_update_interval) {
                const sendOkUpdate = () => {
                    if ((getLastValue("notifications.navigation.anchor", undefined)?.state ?? "normal") !== "normal") {
                        // Status is not OK
                    } else if (getLastValue("navigation.anchor.maxRadius", undefined) != null) {
                        // Anchor is set, status OK
                        sendPush({
                            message: `OK ${getStatusText()}`,
                            ttl: settings.anchor_ok_update_interval * 1000,
                        });
                    } else {
                        // Anchor is not set
                    }
                }

                anchorStatusTimeout = setTimeout(() => {
                    sendOkUpdate();
                    anchorStatusInterval = setInterval(() => {
                        sendOkUpdate();
                    }, settings.anchor_ok_update_interval * 1000);
                }, (settings.anchor_ok_update_interval * 1000) - Date.now() % (settings.anchor_ok_update_interval * 1000))
            }

            app.subscriptionmanager.subscribe(
                {
                    context: "vessels.self",
                    subscribe: [
                        {
                            path: "notifications.*",
                        },
                        {
                            path: "navigation.anchor.*",
                        },
                        {
                            path: "environment.depth.*",
                        },
                        {
                            path: "navigation.position",
                        }
                    ],
                },
                unsubscribes,
                subscriptionError => {
                    app.error('Error:' + subscriptionError);
                },
                async (delta) => {
                    for (const update of delta.updates) {
                        for (const { path, value, ...rest } of update.values) {
                            const oldValue = getLastValue(path, undefined);
                            setLastValue(path, value);

                            switch (path) {
                                case "navigation.anchor.bearingTrue":
                                    break;
                                case "navigation.anchor.currentRadius":
                                    break;
                                case "navigation.anchor.maxRadius":
                                    if (value == null && oldValue != null) {
                                        // Anchor raised
                                        setTimeout(() => {
                                            sendPush({
                                                message: `Anchor Raised`,
                                                ttl: 60,
                                            });
                                        }, 1000);
                                    } else if (value != null && oldValue === null) {
                                        // Anchor dropped
                                        setTimeout(() => {
                                            sendPush({
                                                message: `Anchor Dropped ${getStatusText()}`,
                                                ttl: 60,
                                            });
                                        }, 1000);
                                    }
                                    break;

                                case "environment.depth.belowSurface":
                                    break;

                                case "navigation.position":
                                    setPositionUpdateTimeout();
                                    break;

                                case "notifications.navigation.anchor": {
                                    const oldState = oldValue?.state ?? "normal";
                                    const newState = value?.state ?? "normal";
                                    if (newState !== oldState) {
                                        if (newState === "emergency" || newState === "alarm") {
                                            sendPush({
                                                message: `ANCHOR ${newState === "emergency" ? "ALARM" : "WARN"} ${getStatusText()}`,
                                                priority: newState === "emergency" ? 2 : 1,
                                                retry: 30,
                                                expire: 600,
                                            });
                                        } else if (newState === "normal") {
                                            sendPush({
                                                message: `Anchor OK ${getStatusText()}`,
                                                ttl: 60,
                                            });
                                        }
                                    }
                                    break;
                                }

                                case "notifications.environment.depth.belowSurface": {
                                    const oldState = oldValue?.state ?? "normal";
                                    const newState = value?.state ?? "normal";
                                    if (newState !== oldState && getLastValueAsNumber("navigation.anchor.maxRadius", undefined) != null) {
                                        if (newState === "emergency" || newState === "alarm") {
                                            sendPush({
                                                message: `DEPTH ${newState === "emergency" ? 'ALARM' : "WARN"} ${getStatusText()}`,
                                                priority: newState === "emergency" ? 2 : 1,
                                                retry: 30,
                                                expire: 600,
                                            });
                                        } else if (newState === "normal") {
                                            sendPush({
                                                message: `DEPTH OK ${getStatusText()}`,
                                                ttl: 60,
                                            });
                                        }
                                    }
                                    break;
                                }

                                default:
                                    break;
                            }
                        }
                    }
                }
            );
        },
        stop: () => {
            if (anchorStatusTimeout != null) {
                clearTimeout(anchorStatusTimeout);
                anchorStatusTimeout = undefined;
            }
            if (anchorStatusInterval != null) {
                clearInterval(anchorStatusInterval);
                anchorStatusInterval = undefined;
            }
            if (positionUpdateTimeout != null) {
                clearTimeout(positionUpdateTimeout);
                positionUpdateTimeout = undefined;
            }

            unsubscribes?.forEach(f => f());
            unsubscribes = [];
        },
        schema: () => ({
            properties: {
                pushover_user: {
                    type: 'string',
                    title: 'Pushover user/group key',
                },
                anchor_ok_update_interval: {
                    type: 'number',
                    title: 'Interval in seconds in which to send "OK" anchor status notification (0 to disable)',
                    default: 0
                },
                no_position_alert_interval: {
                    type: 'number',
                    title: 'Timeout in seconds after which to send alert if no position update received (0 to disable)',
                    default: 60
                },
            },
        }),
    };

    return plugin;
};

