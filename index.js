const { exec } = require('child_process');

const PUSHOVER_TOKEN = 'a5q57vtxjqzz56qo6gnnbmj6omyip7';

const PUSHOVER_ANCHOR_TAG = 'anchor-alarm';
const PUSHOVER_DEPTH_TAG = 'depth-alarm';

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
    let started = false;

    const getStatusText = () => {
        const currentRadius = getLastValueAsNumber("navigation.anchor.currentRadius", 60);
        const maxRadius = getLastValueAsNumber("navigation.anchor.maxRadius", undefined);
        const bearingTrue = getLastValueAsNumber("navigation.anchor.bearingTrue", 60);
        const depthBelowSurface = getLastValueAsNumber("environment.depth.belowSurface", 60);

        return `${currentRadius?.toFixed(0) ?? '?'}/${maxRadius?.toFixed(0) ?? '?'} m @ ${bearingTrue != null ? (bearingTrue * 180 / Math.PI).toFixed(0) : '?'} deg${depthBelowSurface != null ? `, depth ${depthBelowSurface?.toFixed(1) ?? '?'} m` : ''}`
    };

    let settings;
    const fetchPushoverApiRequest = async (url, body = {}) => {
        if (settings?.pushover_user == null) {
            app.error('Pushover user not set');
            throw new Error('Pushover user not set');
        }
        return fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                token: PUSHOVER_TOKEN,
                user: settings.pushover_user,
                ...body,
            }).toString()
        });
    }

    const sendPush = async (options = {}) => {
        const res = await fetchPushoverApiRequest('https://api.pushover.net/1/messages.json', {
            title: 'Anchor Alarm',
            ...options,
        });
        if (!res.ok) {
            app.error(`Failed to send push notification ${JSON.stringify(options)}: HTTP ${res.status} ${res.statusText}`);
            app.error(`Response: ${await res.text()}`);
            throw new Error(`Failed to send push notification: HTTP ${res.status} ${res.statusText}`);
        } else {
            const resBody = await res.json();
            app.debug(`Push notification ${JSON.stringify(options)} sent: ${JSON.stringify(resBody)}`);
        }
    }

    const cancelAllEmergencyReceipts = async (tag) => {
        const res = await fetchPushoverApiRequest(`https://api.pushover.net/1/receipts/cancel_by_tag/${tag}.json`);
        if (!res.ok) {
            app.error(`Failed to cancel emergency receipts: HTTP ${res.status} ${res.statusText}`);
            app.error(`Response: ${await res.text()}`);
            throw new Error(`Failed to cancel emergency receipts: HTTP ${res.status} ${res.statusText}`);
        } else {
            app.debug(`Cancelled emergency receipts with tag "${tag}"`);
        }
    }

    const runCmd = (cmd) => {
        if (!cmd.trim().length) {
            return;
        }
        app.debug(`Executing command: ${cmd}`);
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                app.error(`Error executing command "${cmd}": ${error.message}`);
            }
        });
    }

    let draggingCmdInterval;

    /** @type {Plugin} */
    const plugin = {
        id: "signalk-pushover-plugin",
        name: "Anchor Alarm (Pushover push notifications)",
        start: (startSettings, restartPlugin) => {
            started = true;
            settings = startSettings;

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
                        runCmd(settings.anchor_ok_cmd);
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
                                            runCmd(settings.anchor_raised_cmd);
                                        }, 1000);
                                    } else if (value != null && oldValue === null) {
                                        // Anchor dropped
                                        setTimeout(() => {
                                            sendPush({
                                                message: `Anchor Dropped ${getStatusText()}`,
                                                ttl: 60,
                                            });
                                            runCmd(settings.anchor_set_cmd);
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
                                                tags: PUSHOVER_ANCHOR_TAG,
                                            });
                                            runCmd(settings.anchor_dragging_cmd);
                                            if (draggingCmdInterval != null) {
                                                clearInterval(draggingCmdInterval);
                                            }
                                            draggingCmdInterval = setInterval(() => {
                                                runCmd(settings.anchor_dragging_cmd);
                                            }, 10 * 1000);
                                        } else if (newState === "normal") {
                                            if (draggingCmdInterval != null) {
                                                clearInterval(draggingCmdInterval);
                                                draggingCmdInterval = undefined;
                                            }
                                            sendPush({
                                                message: `Anchor OK ${getStatusText()}`,
                                                ttl: 60,
                                            });
                                            runCmd(settings.anchor_ok_cmd);

                                            cancelAllEmergencyReceipts(PUSHOVER_ANCHOR_TAG).catch(() => { });
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
                                                tags: PUSHOVER_DEPTH_TAG,
                                            });
                                        } else if (newState === "normal") {
                                            sendPush({
                                                message: `DEPTH OK ${getStatusText()}`,
                                                ttl: 60,
                                            });

                                            cancelAllEmergencyReceipts(PUSHOVER_DEPTH_TAG).catch(() => { });
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
            started = false;

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
        registerWithRouter: (router) => {
            // GET http://192.168.2.11:3001/plugins/signalk-pushover-plugin/status
            router.get('/status', (req, res) => {
                res.json({
                    started,
                    values: lastValues,
                });
            });
            router.post('/test', (req, res) => {
                sendPush({
                    message: `TEST ${getStatusText()}`,
                    ttl: 60,
                }).then(() => {
                    res.json({
                        sent: true
                    });
                }).catch((err) => {
                    res.status(500).json({
                        sent: false,
                        error: err.message,
                    });
                });
                const notification = getLastValue("notifications.navigation.anchor")?.state ?? "normal";
                if (notification === "emergency" || notification === "alarm") {
                    runCmd(settings.anchor_dragging_cmd);
                } else if (notification === "normal") {
                    runCmd(settings.anchor_ok_cmd);
                }
            });
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
                anchor_dragging_cmd: {
                    type: 'string',
                    title: 'Command to execute when anchor dragging is detected',
                },
                anchor_set_cmd: {
                    type: 'string',
                    title: 'Command to execute when anchor is set',
                },
                anchor_raised_cmd: {
                    type: 'string',
                    title: 'Command to execute when anchor is raised',
                },
                anchor_ok_cmd: {
                    type: 'string',
                    title: 'Command to execute when anchor status is OK',
                },
                gps_lost_cmd: {
                    type: 'string',
                    title: 'Command to execute when GPS position updates are lost',
                },
            },
        }),
    };

    return plugin;
};

