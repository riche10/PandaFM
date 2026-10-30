"""5.5.2: PandaFM owns track likes. Make the likes it already has durable.

Existing track_preferences.liked = true rows (including likes recovered after a music-server migration)
are kept exactly as they are. Those without any favorite/unfavorite history (they were mirrored from
Navidrome stars before 5.5.2) get one 'favorite' event (source 'migration-0009'), so PandaFM can rebuild
its liked state from its own events alone. Idempotent and nondestructive: nothing is reset or removed,
and running it again adds nothing.
"""

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO listening_events (event_id, user_id, track_id, play_id, event_type, occurred_at, source, details)
        SELECT gen_random_uuid(), p.user_id, p.track_id, gen_random_uuid(), 'favorite', now(), 'migration-0009',
               '{"backfill": "liked before 5.5.2"}'::jsonb
        FROM track_preferences p
        WHERE p.liked AND NOT EXISTS (
            SELECT 1 FROM listening_events e
            WHERE e.user_id = p.user_id AND e.track_id = p.track_id AND e.event_type IN ('favorite', 'unfavorite'))
    """)


def downgrade() -> None:
    # The backfilled events are harmless history; liked state was never changed. Nothing to undo.
    pass
