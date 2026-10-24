"""Download manifests: what the app needs to fetch a song, an album, a playlist or Favorites."""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.library import AudioQuality, Track


class ProfileInfo(BaseModel):
    id: str
    label: str
    description: str


class DownloadPlan(BaseModel):
    profile: str
    action: Literal["original", "convert"]
    extension: str
    codec: str
    lossless: bool | None
    bitrate_kbps: int | None
    sample_rate: int | None
    bit_depth: int | None
    estimated_bytes: int | None
    exact_size: bool
    note: str | None = None


class AudioInfo(BaseModel):
    track: Track
    quality: AudioQuality | None
    source_revision: str | None
    plans: list[DownloadPlan]  # what each profile would give for this song


class PrepareRequest(BaseModel):
    kind: Literal["tracks", "album", "playlist", "favorites"]
    id: str | None = Field(default=None, max_length=200)
    track_ids: list[str] = Field(default_factory=list, max_length=5000)
    profile: str = "original"
    warm: bool = True  # start server-side conversions straight away


class ManifestItem(BaseModel):
    track: Track
    plan: DownloadPlan
    relative_path: str  # Music/Artist/Album/01 - Title.ext (always relative and clean)
    url: str  # /api/downloads/files/{track}/{profile}
    source_revision: str | None
    size_bytes: int | None  # exact when known (original, or already converted)
    sha256: str | None
    status: Literal["ready", "pending"]


class ProfileEstimate(BaseModel):
    profile: str
    label: str
    bytes: int
    exact: bool  # false: an estimate (conversions not made yet)


class Manifest(BaseModel):
    kind: str
    id: str | None
    name: str
    profile: str
    duration_seconds: int
    items: list[ManifestItem]
    estimates: list[ProfileEstimate]
