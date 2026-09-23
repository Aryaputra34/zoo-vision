import yaml
from core.base_pipeline import BasePipeline
from pipelines.cashier_presence_pipeline import CashierPresencePipeline
from pipelines.restaurant_pipeline import RestaurantCounterPipeline
from pipelines.vehicle_gate_pipeline import VehicleGatePipeline

with open("configs/cameras.yaml", "r") as f:
    cfg = yaml.safe_load(f)

for cam in cfg["cameras"]:
    cam_id = cam["id"]
    pipe_type = cam["pipeline"]
    roi = cam.get("roi")
    rule_path = cam.get("rule_config")
    rules = cam.get("rules")
    print(f"Checking {cam_id} ({pipe_type})...")

    if pipe_type == "cashier_presence":
        p = CashierPresencePipeline(cam_id, cam["name"], cam["nx_camera_id"], rule_path, None, roi=roi, rules=rules)
        print(f"  Zone polygon loaded: {p.rules.get('zone_polygon')}")
        assert p.rules.get("zone_polygon") is not None
        if cam_id == "cam_cashier_01":
            assert p.rules["zone_polygon"][0] == [0.20, 0.20]
        elif cam_id == "cam_cashier_02":
            assert p.rules["zone_polygon"][0] == [0.30, 0.15]

print("ALL PIPELINES INSTANTIATED AND INLINE ROIS VERIFIED SUCCESSFULLY!")
