"""Each pipeline's `live` status (what the API serves in cam:{id}:status) matches its live contract."""
import numpy as np
import pytest
from conftest import make_pipeline
from contracts.cashier_presence.live import CashierPresenceLive
from contracts.horse_riding.live import HorseRidingLive
from contracts.restaurant_counter.live import RestaurantCounterLive
from contracts.restaurant_table.live import RestaurantTableLive
from contracts.vehicle_gate.live import VehicleGateLive

FRAME = np.zeros((720, 1280, 3), np.uint8)
LIVE_MODELS = {
    "cashier_presence": CashierPresenceLive,
    "horse_riding": HorseRidingLive,
    "restaurant_counter": RestaurantCounterLive,
    "restaurant_table": RestaurantTableLive,
    "vehicle_gate": VehicleGateLive,
}


@pytest.mark.parametrize("use_case", sorted(LIVE_MODELS))
def test_live_matches_contract(fake_yolo, use_case):
    pipeline = make_pipeline(use_case)
    for ts in (40_000, 41_000):
        pipeline.run(FRAME.copy(), ts)
    assert pipeline.live, "the pipeline reported no live values"
    LIVE_MODELS[use_case].model_validate(pipeline.live, strict=True)


def test_table_use_cases_report_their_tables(fake_yolo):
    for use_case in ("restaurant_table", "restaurant_counter"):
        pipeline = make_pipeline(use_case)
        pipeline.run(FRAME.copy(), 40_000)
        assert pipeline.live.get("tables"), f"{use_case} reported no tables"
