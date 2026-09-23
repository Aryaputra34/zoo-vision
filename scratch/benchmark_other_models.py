import os
import time
import cv2
from ultralytics import YOLO, RTDETR
import supervision as sv

def main():
    img_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\restoran_26_53_raw.jpg"
    frame = cv2.imread(img_path)
    if frame is None:
        print("Raw frame not found!")
        return
        
    test_models = [
        ("yolo26l.pt", YOLO, [1280, 1920]),
        ("yolo26x.pt", YOLO, [1280]),
        ("rtdetr-l.pt", RTDETR, [1280]),
    ]
    
    print("=== TESTING ADDITIONAL STATE-OF-THE-ART CANDIDATES ===")
    for m_name, loader, imgszs in test_models:
        try:
            print(f"\nLoading {m_name}...")
            model = loader(m_name)
            for sz in imgszs:
                t0 = time.time()
                res = model(frame, classes=[0], conf=0.20, imgsz=sz, verbose=False)[0]
                dt = (time.time() - t0) * 1000
                dets = sv.Detections.from_ultralytics(res)
                print(f"Model: {m_name:<12} | imgsz: {sz:<5} | Detections: {len(dets):<3} | Time: {dt:.0f} ms | Mean Conf: {dets.confidence.mean():.2f}")
                
                # Save visualization for comparison
                box_ann = sv.BoxAnnotator(thickness=2)
                lbl_ann = sv.LabelAnnotator(text_scale=0.4, text_thickness=1)
                ann = box_ann.annotate(frame.copy(), detections=dets)
                labels = [f"person {c:.2f}" for c in dets.confidence]
                ann = lbl_ann.annotate(ann, detections=dets, labels=labels)
                out_path = rf"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\comp_{m_name.split('.')[0]}_{sz}.jpg"
                cv2.imwrite(out_path, ann)
        except Exception as e:
            print(f"Error testing {m_name}: {e}")

if __name__ == "__main__":
    main()
