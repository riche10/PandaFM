package app.pandafm.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The download service is requested once per stopped-to-running cycle, never in a loop. */
public class ServiceGateTest {
    @Test
    public void firstQueuedJobRequestsTheService() {
        ServiceGate gate = new ServiceGate();
        assertFalse(gate.shouldRequest(false)); // nothing to do: no service
        assertTrue(gate.shouldRequest(true));
        assertTrue(gate.isRequested());
    }

    @Test
    public void manySongsBeforeTheServiceStartsAreOneRequest() {
        ServiceGate gate = new ServiceGate();
        int requests = 0;
        for (int song = 0; song < 14; song++) if (gate.shouldRequest(true)) requests++;
        assertEquals(1, requests);
    }

    @Test
    public void aRunningServiceIsNeverRequestedAgain() {
        ServiceGate gate = new ServiceGate();
        gate.shouldRequest(true);
        gate.started();
        for (int i = 0; i < 100; i++) assertFalse(gate.shouldRequest(true)); // network changes, resumes, folder picks...
    }

    @Test
    public void afterItStopsNewWorkRequestsItAgain() {
        ServiceGate gate = new ServiceGate();
        gate.shouldRequest(true);
        gate.started();
        gate.stopped();
        assertFalse(gate.isRunning());
        assertTrue(gate.shouldRequest(true));
    }

    @Test
    public void aRefusedStartCanBeRetriedByALaterEvent() {
        ServiceGate gate = new ServiceGate();
        gate.shouldRequest(true);
        gate.requestFailed();
        assertTrue(gate.shouldRequest(true));
    }

    /**
     * The call graph of an album download, with Android delivering
     * onStartCommand right away: enqueue -> schedule -> request ->
     * onStartCommand -> scheduleWorkers (no request) -> songs finish ->
     * scheduleWorkers (no request). Exactly one service request.
     */
    @Test
    public void anAlbumDownloadIsOneServiceStartWithoutRecursion() {
        final ServiceGate gate = new ServiceGate();
        final int[] requests = {0};
        final int[] startCommands = {0};
        final int[] remaining = {12};
        class Lifecycle {
            void schedule() { // external events
                if (gate.shouldRequest(remaining[0] > 0)) {
                    requests[0]++;
                    onStartCommand(); // Android may deliver it immediately
                }
                scheduleWorkers();
            }

            void onStartCommand() {
                startCommands[0]++;
                if (startCommands[0] > 5) throw new AssertionError("service start loop");
                gate.started();
                scheduleWorkers();
            }

            void scheduleWorkers() {
                // starts workers only
            }

            void finishOne() {
                remaining[0]--;
                scheduleWorkers();
                if (remaining[0] == 0) gate.stopped(); // the service stops when no work remains
            }
        }
        Lifecycle app = new Lifecycle();
        app.schedule(); // enqueue 12 songs
        app.schedule(); // a network change meanwhile
        while (remaining[0] > 0) app.finishOne();
        assertEquals(1, requests[0]);
        assertEquals(1, startCommands[0]);
        remaining[0] = 3; // a playlist later
        app.schedule();
        assertEquals(2, requests[0]);
    }
}
