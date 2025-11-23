import { generateSchedule } from './scheduler.js';

self.onmessage = async function (e) {
    const { type, payload, id } = e.data;

    if (type === 'GENERATE_SCHEDULE') {
        try {
            const result = await generateSchedule(payload);
            self.postMessage({ type: 'SUCCESS', payload: result, id });
        } catch (error) {
            self.postMessage({
                type: 'ERROR',
                payload: { message: error.message, stack: error.stack },
                id
            });
        }
    }
};
