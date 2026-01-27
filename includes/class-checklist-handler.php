<?php
/**
 * Checklist Handler
 *
 * Manages checklist items (CRUD operations)
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Checklist Handler class
 */
class KPT_Checklist_Handler {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Checklist_Handler
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Checklist_Handler
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    /**
     * Constructor
     */
    private function __construct() {
        add_action('wp_ajax_kpt_add_checklist_item', array($this, 'ajax_add_item'));
        add_action('wp_ajax_kpt_update_checklist_item', array($this, 'ajax_update_item'));
        add_action('wp_ajax_kpt_delete_checklist_item', array($this, 'ajax_delete_item'));
        add_action('wp_ajax_kpt_toggle_checklist_item', array($this, 'ajax_toggle_item'));
        add_action('wp_ajax_kpt_reorder_checklist_items', array($this, 'ajax_reorder_items'));
    }
    
    /**
     * Get checklist items for a project
     *
     * @param int $project_id Project ID
     * @param int $stage Optional stage filter
     * @param string $trade_type Optional trade type filter
     * @return array Checklist items
     */
    public function get_items($project_id, $stage = null, $trade_type = null) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_checklist_items';
        
        $where = array($wpdb->prepare('project_id = %d', $project_id));
        
        if ($stage !== null) {
            $where[] = $wpdb->prepare('stage = %d', $stage);
        }
        
        if ($trade_type !== null) {
            $where[] = $wpdb->prepare('trade_type = %s', $trade_type);
        }
        
        $sql = "SELECT * FROM $table WHERE " . implode(' AND ', $where) . " ORDER BY sort_order ASC, id ASC";
        
        return $wpdb->get_results($sql);
    }
    
    /**
     * Get a single checklist item
     *
     * @param int $item_id Item ID
     * @return object|null Item object or null
     */
    public function get_item($item_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_checklist_items';
        
        return $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id = %d", $item_id));
    }
    
    /**
     * Add a checklist item
     *
     * @param array $data Item data
     * @return int|false Item ID on success, false on failure
     */
    public function add_item($data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_checklist_items';
        
        $defaults = array(
            'project_id' => 0,
            'stage' => 1,
            'item_text' => '',
            'is_completed' => 0,
            'completed_by' => null,
            'completed_at' => null,
            'sort_order' => 0,
            'trade_type' => null,
            'notes' => null,
            'photo_url' => null,
        );
        
        $data = wp_parse_args($data, $defaults);
        
        // Sanitize data
        $insert_data = array(
            'project_id' => absint($data['project_id']),
            'stage' => absint($data['stage']),
            'item_text' => sanitize_textarea_field($data['item_text']),
            'is_completed' => absint($data['is_completed']),
            'completed_by' => $data['completed_by'] ? absint($data['completed_by']) : null,
            'completed_at' => $data['completed_at'],
            'sort_order' => absint($data['sort_order']),
            'trade_type' => $data['trade_type'] ? sanitize_text_field($data['trade_type']) : null,
            'notes' => $data['notes'] ? sanitize_textarea_field($data['notes']) : null,
            'photo_url' => $data['photo_url'] ? esc_url_raw($data['photo_url']) : null,
        );
        
        $result = $wpdb->insert($table, $insert_data);
        
        if ($result === false) {
            return false;
        }
        
        do_action('kpt_checklist_item_added', $wpdb->insert_id, $data);
        
        return $wpdb->insert_id;
    }
    
    /**
     * Update a checklist item
     *
     * @param int $item_id Item ID
     * @param array $data Item data
     * @return bool True on success, false on failure
     */
    public function update_item($item_id, $data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_checklist_items';
        
        $item = $this->get_item($item_id);
        if (!$item) {
            return false;
        }
        
        $update_data = array();
        
        if (isset($data['item_text'])) {
            $update_data['item_text'] = sanitize_textarea_field($data['item_text']);
        }
        
        if (isset($data['stage'])) {
            $update_data['stage'] = absint($data['stage']);
        }
        
        if (isset($data['is_completed'])) {
            $update_data['is_completed'] = absint($data['is_completed']);
        }
        
        if (isset($data['completed_by'])) {
            $update_data['completed_by'] = $data['completed_by'] ? absint($data['completed_by']) : null;
        }
        
        if (isset($data['completed_at'])) {
            $update_data['completed_at'] = $data['completed_at'];
        }
        
        if (isset($data['sort_order'])) {
            $update_data['sort_order'] = absint($data['sort_order']);
        }
        
        if (isset($data['trade_type'])) {
            $update_data['trade_type'] = $data['trade_type'] ? sanitize_text_field($data['trade_type']) : null;
        }
        
        if (isset($data['notes'])) {
            $update_data['notes'] = $data['notes'] ? sanitize_textarea_field($data['notes']) : null;
        }
        
        if (isset($data['photo_url'])) {
            $update_data['photo_url'] = $data['photo_url'] ? esc_url_raw($data['photo_url']) : null;
        }
        
        $result = $wpdb->update($table, $update_data, array('id' => $item_id));
        
        if ($result !== false) {
            do_action('kpt_checklist_item_updated', $item_id, $data);
        }
        
        return $result !== false;
    }
    
    /**
     * Delete a checklist item
     *
     * @param int $item_id Item ID
     * @return bool True on success, false on failure
     */
    public function delete_item($item_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_checklist_items';
        
        $item = $this->get_item($item_id);
        if (!$item) {
            return false;
        }
        
        $result = $wpdb->delete($table, array('id' => $item_id), array('%d'));
        
        if ($result !== false) {
            do_action('kpt_checklist_item_deleted', $item_id, $item);
        }
        
        return $result !== false;
    }
    
    /**
     * Toggle checklist item completion
     *
     * @param int $item_id Item ID
     * @param int $user_id User ID
     * @return bool True on success, false on failure
     */
    public function toggle_item($item_id, $user_id) {
        $item = $this->get_item($item_id);
        if (!$item) {
            return false;
        }
        
        $data = array(
            'is_completed' => $item->is_completed ? 0 : 1,
            'completed_by' => $item->is_completed ? null : $user_id,
            'completed_at' => $item->is_completed ? null : current_time('mysql'),
        );
        
        return $this->update_item($item_id, $data);
    }
    
    /**
     * Get completion percentage for a project/stage
     *
     * @param int $project_id Project ID
     * @param int $stage Optional stage filter
     * @return float Completion percentage
     */
    public function get_completion_percentage($project_id, $stage = null) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_checklist_items';
        
        $where = $wpdb->prepare('project_id = %d', $project_id);
        
        if ($stage !== null) {
            $where .= $wpdb->prepare(' AND stage = %d', $stage);
        }
        
        $total = $wpdb->get_var("SELECT COUNT(*) FROM $table WHERE $where");
        
        if (!$total) {
            return 0;
        }
        
        $completed = $wpdb->get_var("SELECT COUNT(*) FROM $table WHERE $where AND is_completed = 1");
        
        return ($completed / $total) * 100;
    }
    
    /**
     * AJAX: Add checklist item
     */
    public function ajax_add_item() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id || !$this->user_can_manage_checklist($project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array(
            'project_id' => $project_id,
            'stage' => isset($_POST['stage']) ? absint($_POST['stage']) : 1,
            'item_text' => isset($_POST['item_text']) ? sanitize_textarea_field($_POST['item_text']) : '',
            'trade_type' => isset($_POST['trade_type']) ? sanitize_text_field($_POST['trade_type']) : null,
            'sort_order' => isset($_POST['sort_order']) ? absint($_POST['sort_order']) : 0,
        );
        
        $item_id = $this->add_item($data);
        
        if ($item_id) {
            wp_send_json_success(array(
                'message' => __('Checklist item added.', 'kelbe-project-tracker'),
                'item_id' => $item_id,
                'item' => $this->get_item($item_id),
            ));
        } else {
            wp_send_json_error(__('Failed to add checklist item.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Update checklist item
     */
    public function ajax_update_item() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $item_id = isset($_POST['item_id']) ? absint($_POST['item_id']) : 0;
        $item = $this->get_item($item_id);
        
        if (!$item || !$this->user_can_manage_checklist($item->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array();
        
        if (isset($_POST['item_text'])) {
            $data['item_text'] = sanitize_textarea_field($_POST['item_text']);
        }
        
        if (isset($_POST['notes'])) {
            $data['notes'] = sanitize_textarea_field($_POST['notes']);
        }
        
        if (isset($_POST['photo_url'])) {
            $data['photo_url'] = esc_url_raw($_POST['photo_url']);
        }
        
        if ($this->update_item($item_id, $data)) {
            wp_send_json_success(array(
                'message' => __('Checklist item updated.', 'kelbe-project-tracker'),
                'item' => $this->get_item($item_id),
            ));
        } else {
            wp_send_json_error(__('Failed to update checklist item.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Delete checklist item
     */
    public function ajax_delete_item() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $item_id = isset($_POST['item_id']) ? absint($_POST['item_id']) : 0;
        $item = $this->get_item($item_id);
        
        if (!$item || !$this->user_can_manage_checklist($item->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        if ($this->delete_item($item_id)) {
            wp_send_json_success(__('Checklist item deleted.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to delete checklist item.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Toggle checklist item
     */
    public function ajax_toggle_item() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $item_id = isset($_POST['item_id']) ? absint($_POST['item_id']) : 0;
        $item = $this->get_item($item_id);
        
        if (!$item || !$this->user_can_manage_checklist($item->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $user_id = get_current_user_id();
        
        if ($this->toggle_item($item_id, $user_id)) {
            $updated_item = $this->get_item($item_id);
            wp_send_json_success(array(
                'message' => __('Checklist item updated.', 'kelbe-project-tracker'),
                'item' => $updated_item,
                'is_completed' => (bool) $updated_item->is_completed,
            ));
        } else {
            wp_send_json_error(__('Failed to update checklist item.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Reorder checklist items
     */
    public function ajax_reorder_items() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id || !$this->user_can_manage_checklist($project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $order = isset($_POST['order']) ? $_POST['order'] : array();
        
        foreach ($order as $index => $item_id) {
            $this->update_item(absint($item_id), array('sort_order' => $index));
        }
        
        wp_send_json_success(__('Checklist items reordered.', 'kelbe-project-tracker'));
    }
    
    /**
     * Check if user can manage checklist for a project
     *
     * @param int $project_id Project ID
     * @return bool True if user can manage, false otherwise
     */
    private function user_can_manage_checklist($project_id) {
        $user_id = get_current_user_id();
        
        // Admins can always manage
        if (current_user_can('manage_options')) {
            return true;
        }
        
        // Project author can manage
        $project = get_post($project_id);
        if ($project && $project->post_author == $user_id) {
            return true;
        }
        
        // Team members can manage
        $team_manager = KPT_Team_Manager::get_instance();
        $member = $team_manager->get_team_member($project_id, $user_id);
        
        return (bool) $member;
    }
}
