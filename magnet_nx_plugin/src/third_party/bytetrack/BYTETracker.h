#pragma once

#include <climits>

#include "STrack.h"

namespace bytetrack {

// Magnet: replaces cv::Rect_<float>. Top-left corner, width and height, in PIXELS: ious() adds 1
// to every extent, which is only meaningful in pixel units.
struct Rect
{
    float x;
    float y;
    float width;
    float height;
};

struct Object
{
    Rect rect;
    int label;
    float prob;
};

class BYTETracker
{
public:
	// Magnet: track_thresh, high_thresh and match_thresh were hardcoded (0.5 / 0.6 / 0.8) in the
	// constructor; they are parameters so the plugin can mirror the Python pipelines' settings.
	BYTETracker(int frame_rate = 30, int track_buffer = 30,
		float track_thresh = 0.5f, float high_thresh = 0.6f, float match_thresh = 0.8f);
	~BYTETracker();

	vector<STrack> update(const vector<Object>& objects);
	// Magnet: get_color() removed (display-only, returned cv::Scalar).

private:
	vector<STrack*> joint_stracks(vector<STrack*> &tlista, vector<STrack> &tlistb);
	vector<STrack> joint_stracks(vector<STrack> &tlista, vector<STrack> &tlistb);

	vector<STrack> sub_stracks(vector<STrack> &tlista, vector<STrack> &tlistb);
	void remove_duplicate_stracks(vector<STrack> &resa, vector<STrack> &resb, vector<STrack> &stracksa, vector<STrack> &stracksb);

	void linear_assignment(vector<vector<float> > &cost_matrix, int cost_matrix_size, int cost_matrix_size_size, float thresh,
		vector<vector<int> > &matches, vector<int> &unmatched_a, vector<int> &unmatched_b);
	vector<vector<float> > iou_distance(vector<STrack*> &atracks, vector<STrack> &btracks, int &dist_size, int &dist_size_size);
	vector<vector<float> > iou_distance(vector<STrack> &atracks, vector<STrack> &btracks);
	vector<vector<float> > ious(vector<vector<float> > &atlbrs, vector<vector<float> > &btlbrs);

	double lapjv(const vector<vector<float> > &cost, vector<int> &rowsol, vector<int> &colsol, 
		bool extend_cost = false, float cost_limit = LONG_MAX, bool return_cost = true);

private:

	float track_thresh;
	float high_thresh;
	float match_thresh;
	int frame_id;
	int max_time_lost;

	vector<STrack> tracked_stracks;
	vector<STrack> lost_stracks;
	// Magnet: the removed_stracks member is gone. Upstream appended every removed track to it and
	// never trimmed it, so memory and the per-update sub_stracks() cost grew for as long as the
	// process ran - fatal inside a 24/7 mediaserver. update() now uses only the current pass's
	// removals, which is all it ever needed.
	byte_kalman::KalmanFilter kalman_filter;
};

} // namespace bytetrack