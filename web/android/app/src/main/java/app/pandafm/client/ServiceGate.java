package app.pandafm.client;

/**
 * When the download queue may ask Android to start DownloadService.
 *
 * One start request per stopped-to-running cycle: none while the service is
 * running, none while a request is already on its way, a new one only after
 * the service has stopped (or a request was refused). Without this, every
 * schedule() asked for the service again, and the service's own
 * onStartCommand() scheduled, which asked again: an endless start loop.
 *
 * Pure (no Android types), so plain JUnit can test it.
 */
final class ServiceGate {
    private boolean running;
    private boolean requested;

    /** Work exists: should Android be asked to start the service now? Records the request if so. */
    synchronized boolean shouldRequest(boolean hasWork) {
        if (!hasWork || running || requested) return false;
        requested = true;
        return true;
    }

    /** The service is in the foreground (onStartCommand succeeded). */
    synchronized void started() {
        running = true;
        requested = false;
    }

    /** The service stopped or was destroyed: the next work may request it again. */
    synchronized void stopped() {
        running = false;
        requested = false;
    }

    /** Android refused the start (e.g. from the background): a later event may try again. */
    synchronized void requestFailed() {
        requested = false;
    }

    synchronized boolean isRunning() {
        return running;
    }

    synchronized boolean isRequested() {
        return requested;
    }
}
